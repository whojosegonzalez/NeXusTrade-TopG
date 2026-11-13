/**
 * PaperRollingCandidateFlowProvider (offline, synthetic).
 *
 * Every chain, transaction, candidate, price and security input below is SYNTHETIC. Time is a deterministic
 * virtual scheduler: every provider wait and every mocked response latency is a virtual timer, fired one at a
 * time with microtasks drained in between. HTTP and WebSocket transports are in-memory mocks. No network,
 * socket, daemon, wallet or session is used. The 600-second lifetime is simulated in virtual time.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PaperRollingCandidateFlowProvider,
  PaperRollingDispatchBudget,
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
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
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
  // Largest synthetic response (a decoded swap transaction) is a few KB; 64 KiB bounds every body.
  maxResponseBytes: 65_536,
  subscriptionAckTimeoutMs: 5_000,
  keepalivePingIntervalMs: 20_000,
  keepalivePongTimeoutMs: 10_000,
  // 600 s / 20 s = 30 pings at most (including one reconnect).
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

// ---------------------------------------------------------------------------------------------
// Deterministic virtual scheduler and driver
// ---------------------------------------------------------------------------------------------

interface VirtualTimer {
  readonly id: number;
  readonly at: number;
  /** Late timers fire after ordinary timers due at the same instant (probes, test stops). */
  readonly late: boolean;
  readonly owner: "provider" | "harness";
  readonly fn: () => void;
}

class VirtualScheduler {
  public now: number;
  private seq = 0;
  private readonly timers = new Map<number, VirtualTimer>();

  constructor(start: number) {
    this.now = start;
  }

  add(fn: () => void, ms: number, owner: "provider" | "harness", late = false): number {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.now + Math.max(0, ms), late, owner, fn });
    return id;
  }

  at(atMs: number, fn: () => void, late = false): number {
    return this.add(fn, atMs - this.now, "harness", late);
  }

  clear(id: unknown): void {
    this.timers.delete(id as number);
  }

  count(owner: "provider" | "harness"): number {
    let n = 0;
    for (const t of this.timers.values()) if (t.owner === owner) n++;
    return n;
  }

  fireNext(): boolean {
    let best: VirtualTimer | undefined;
    for (const t of this.timers.values()) {
      if (
        !best ||
        t.at < best.at ||
        (t.at === best.at &&
          (Number(t.late) < Number(best.late) || (t.late === best.late && t.id < best.id)))
      ) {
        best = t;
      }
    }
    if (!best) return false;
    this.timers.delete(best.id);
    this.now = Math.max(this.now, best.at);
    best.fn();
    return true;
  }
}

/** Drives virtual time until `promise` settles; fails instead of hanging if nothing can progress. */
async function drive<T>(sched: VirtualScheduler, promise: Promise<T>): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      error = e;
    },
  );
  let idle = 0;
  for (let step = 0; step < 500_000; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) {
      if (error) throw error;
      return value as T;
    }
    if (sched.fireNext()) {
      idle = 0;
      continue;
    }
    if (++idle > 400) throw new Error("STUCK: run did not settle and no virtual timer is pending");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("STEP LIMIT");
}

// ---------------------------------------------------------------------------------------------
// Synthetic chain and transports
// ---------------------------------------------------------------------------------------------

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

interface RespondContext {
  readonly method: string;
  readonly call: number;
  readonly id: number;
  readonly now: number;
}

function txSlot(atMs: number): number {
  return BASE_SLOT + Math.floor(atMs / SLOT_MS);
}

const encoder = new TextEncoder();

function createHarness(
  opts: {
    readonly swaps?: readonly SyntheticSwap[];
    readonly latencyMs?: number;
    readonly latencyFor?: (method: string, now: number) => number | undefined;
    readonly cutoffSkewMs?: number;
    readonly dropPongs?: boolean;
    readonly dropPongsAfterMs?: number;
    readonly ackTransports?: number;
    readonly disconnectAtMs?: readonly number[];
    readonly rawMessagesAtMs?: readonly { readonly atMs: number; readonly data: string }[];
    readonly hangMethod?: string;
    /** Replace a response (returned after the normal latency). */
    readonly respond?: (ctx: RespondContext, sched: VirtualScheduler) => Response | undefined;
    readonly limits?: Partial<PaperRollingFlowLimits>;
  } = {},
) {
  const sched = new VirtualScheduler(START_MS);
  const clock = () => sched.now;
  const swaps = opts.swaps ?? [];
  const chainTxs: SyntheticSwap[] = [
    { signature: GENESIS_SIG, atMs: -75_000, side: "BUY", notify: false },
    ...swaps,
  ];
  const latencyMs = opts.latencyMs ?? 100;
  const transports: MockWs[] = [];
  const deliveredAt = new Map<string, number>();
  const fetchLog: { method: string; init: RequestInit | undefined; url: string }[] = [];
  const methodCalls = new Map<string, number>();
  let factoryCalls = 0;

  const current = () => transports[transports.length - 1];
  const live = (ws: MockWs | undefined): ws is MockWs => !!ws && ws.subscribed && !ws.closed;

  for (const s of swaps) {
    if (s.notify === false) continue;
    sched.at(START_MS + s.atMs + (s.notifyDelayMs ?? 300), () => {
      const ws = current();
      if (live(ws)) {
        deliveredAt.set(s.signature, sched.now);
        ws.emitNotification(s.signature, txSlot(s.atMs));
      } // a notification due while unsubscribed is lost, as on a real stream
    });
  }
  for (const m of opts.rawMessagesAtMs ?? []) {
    sched.at(START_MS + m.atMs, () => {
      const ws = current();
      if (live(ws)) ws.emitRaw(m.data);
    });
  }
  for (const d of opts.disconnectAtMs ?? []) {
    sched.at(START_MS + d, () => {
      const ws = current();
      if (ws && !ws.closed) ws.emitClose();
    });
  }

  const delay = (ms: number, signal: AbortSignal | null | undefined) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => {
        sched.clear(id);
        reject(new Error("aborted"));
      };
      const id = sched.add(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        ms,
        "harness",
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  const createWs = (): MockWs => {
    factoryCalls++;
    const index = transports.length + 1;
    const listeners: Record<string, ((...args: never[]) => void)[]> = {};
    const fire = (event: string, ...args: unknown[]) => {
      for (const fn of listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
    };
    const ws: MockWs = {
      subscriptionId: 100 + index,
      subscribed: false,
      closed: false,
      send(data: string) {
        const parsed = JSON.parse(data) as { id?: number; method?: string };
        if (parsed.method === "logsSubscribe" && index <= (opts.ackTransports ?? Infinity)) {
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
        const dropping =
          opts.dropPongs === true ||
          (opts.dropPongsAfterMs !== undefined && sched.now >= START_MS + opts.dropPongsAfterMs);
        if (dropping || !data || ws.closed) return;
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

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const call = (methodCalls.get(body.method) ?? 0) + 1;
    methodCalls.set(body.method, call);
    fetchLog.push({ method: body.method, init, url: String(input) });
    if (opts.hangMethod === body.method) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const now = sched.now;
    let result: unknown;
    if (body.method === "getAccountInfo") {
      result = (
        JSON.parse(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE) as { result: unknown }
      ).result;
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
      if (s) {
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
      } else {
        result = null;
      }
    }
    await delay(opts.latencyFor?.(body.method, now) ?? latencyMs, init?.signal);
    const custom = opts.respond?.(
      { method: body.method, call, id: body.id, now: sched.now },
      sched,
    );
    if (custom) return custom;
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
    timers: {
      setTimeout: (fn, ms) => sched.add(fn, ms, "provider"),
      clearTimeout: (handle) => sched.clear(handle),
    },
  });

  return {
    provider,
    sched,
    clock,
    transports,
    deliveredAt,
    fetchLog,
    counts: () => ({ fetchCalls: fetchLog.length, factoryCalls }),
  };
}

type Harness = ReturnType<typeof createHarness>;

const read = (h: Harness, t: number): CandidateFlowResult => h.provider.getCandidateFlow(TARGET, t);

/** Starts collection, optionally stopping at `stopAtMs` (relative) and sampling reads every `everyMs`. */
async function runUntil(
  h: Harness,
  stopAtMs?: number,
  sample?: {
    readonly everyMs: number;
    readonly onSample: (t: number, r: CandidateFlowResult) => void;
  },
  signal?: AbortSignal,
) {
  if (stopAtMs !== undefined) {
    h.sched.at(START_MS + stopAtMs, () => h.provider.stop("TEST_WINDOW_END"), true);
  }
  if (sample) {
    const tick = () => {
      const r = read(h, h.sched.now);
      if (r.diagnosticReason.startsWith("PAPER_ROLLING_FLOW_STOPPED")) return;
      sample.onSample(h.sched.now, r);
      h.sched.add(tick, sample.everyMs, "harness", true);
    };
    h.sched.add(tick, 0, "harness", true);
  }
  return drive(h.sched, h.provider.start(signal));
}

/** Pacing, no overlap, every dispatch before the deadline, and shared accounting agree with the ledger. */
function expectExecutionInvariants(status: PaperRollingFlowStatus) {
  for (let i = 1; i < status.ledger.length; i++) {
    const prev = status.ledger[i - 1]!;
    const cur = status.ledger[i]!;
    expect(cur.dispatchedAtMs - prev.dispatchedAtMs).toBeGreaterThanOrEqual(2_500);
    expect(prev.completedAtMs).not.toBeNull();
    expect(prev.completedAtMs!).toBeLessThanOrEqual(cur.dispatchedAtMs);
  }
  expect(status.ledger.map((e) => e.seq)).toEqual(status.ledger.map((_, i) => i + 1));
  expect(status.ledger.every((e) => e.dispatchedAtMs < status.deadlineMs!)).toBe(true);
  expect(status.maxConcurrentRpc).toBeLessThanOrEqual(1);
  expect(status.budgetManagerAttempts).toBe(status.httpAttempts);
  expect(status.activeTimers).toBe(0);
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

/** A body stream that delivers `prefix` and then stalls; records cancellation. */
function stalledBody(prefix: string) {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("PaperRollingCandidateFlowProvider (synthetic, offline)", () => {
  it("R1. Import and construction are inert; reads before start are unavailable; limits are validated", async () => {
    const h = createHarness();
    for (let i = 0; i < 1_000; i++) {
      const r = read(h, START_MS + i);
      expect(r.isCoverageSufficient).toBe(false);
      expect(r.diagnosticReason).toBe("PAPER_ROLLING_FLOW_NOT_STARTED");
    }
    expect(h.counts()).toEqual({ fetchCalls: 0, factoryCalls: 0 });
    expect(h.sched.count("provider")).toBe(0);

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
    for (const field of ["maxWsControlFrames", "maxResponseBytes"]) {
      const missing: Record<string, unknown> = { ...OFFLINE_TEST_LIMITS };
      delete missing[field];
      expect(
        () =>
          new PaperRollingCandidateFlowProvider({
            ...base,
            limits: missing as unknown as PaperRollingFlowLimits,
          }),
      ).toThrow(new RegExp(field));
    }
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
    expect(h.sched.count("provider")).toBe(0);
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
    expectExecutionInvariants(s);
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
    expect(s.refreshesPublished).toBeGreaterThanOrEqual(2);

    const pubTimes = s.cycleLog.filter((c) => c.outcome === "PUBLISHED").map((c) => c.endedAtMs);
    const p1 = pubTimes[0]!;
    expect(samples.filter((x) => x.t < p1).every((x) => !x.r.isCoverageSufficient)).toBe(true);
    expect(samples.find((x) => x.t < p1)?.r.diagnosticReason).toContain("WARMING_UP");
    const published = samples.filter((x) => x.r.isCoverageSufficient);
    for (const p of published) {
      expect(p.r.recentBuys60s).toBe(0);
      expect(p.r.recentSells60s).toBe(0);
      const ctx = p.r.paperQualificationContext!;
      expect(ctx.qualificationKind).toBe("QUIET_WINDOW");
      expect(ctx.cutoffAgeMs).toBe(p.t - ctx.researchWindowSpan.windowEndMs);
      expect(ctx.cutoffAgeMs).toBeLessThanOrEqual(15_000);
    }

    // Two eligible ticks 5 s apart may consume the same still-fresh snapshot (no new evidence between).
    const tickA = samples.find((x) => x.t > p1)!;
    const tickB = samples.find((x) => x.t >= tickA.t + 5_000 && x.t < pubTimes[1]!)!;
    expect(tickA.r.isCoverageSufficient && tickB.r.isCoverageSufficient).toBe(true);
    expect(tickB.r.paperQualificationContext!.researchWindowSpan.windowEndMs).toBe(
      tickA.r.paperQualificationContext!.researchWindowSpan.windowEndMs,
    );

    // Identity and context: other pool/mint unavailable; production rejects PAPER evidence.
    const last = published[published.length - 1]!;
    const other = h.provider.getCandidateFlow(
      { poolAddress: GENESIS_SIG, tokenMint: MINT },
      last.t,
    );
    expect(other.isCoverageSufficient).toBe(false);
    expect(
      validateAndSnapshotCandidateFlowResult(last.r, TARGET, last.t, {
        executionContext: "PAPER_SIMULATION",
      }).isCoverageSufficient,
    ).toBe(true);
    expect(
      validateAndSnapshotCandidateFlowResult(last.r, TARGET, last.t, {
        executionContext: "PRODUCTION",
      }).diagnosticReason,
    ).toBe("PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION");
    expect(
      validateAndSnapshotCandidateFlowResult(last.r, TARGET, last.t).isCoverageSufficient,
    ).toBe(false);
    expect(read(h, last.t).diagnosticReason).toContain("PAPER_ROLLING_FLOW_STOPPED");
  });

  it("R3. Quiet continuity is conditional: continuous under favourable timing, gaps (and disarming) otherwise", async () => {
    const good = createHarness({ latencyMs: 100 });
    const goodSamples: { t: number; r: CandidateFlowResult }[] = [];
    const goodReport = await runUntil(good, 160_000, {
      everyMs: 250,
      onSample: (t, r) => goodSamples.push({ t, r }),
    });
    expectExecutionInvariants(goodReport.status);
    const firstPub = goodReport.status.cycleLog.find((c) => c.outcome === "PUBLISHED")!.endedAtMs;
    const afterFirst = goodSamples.filter((x) => x.t > firstPub && x.t < START_MS + 159_000);
    expect(afterFirst.length).toBeGreaterThan(300);
    expect(afterFirst.every((x) => x.r.isCoverageSufficient)).toBe(true);

    // Unfavourable: cutoff block time 2 s behind and 600 ms latency -> STALE reads between snapshots.
    const bad = createHarness({ latencyMs: 600, cutoffSkewMs: -2_000 });
    const badSamples: { t: number; r: CandidateFlowResult; decision?: string }[] = [];
    let armed: ArmedPullbackState | undefined;
    let nextTickAt = START_MS;
    const badReport = await runUntil(bad, 160_000, {
      everyMs: 250,
      onSample: (t, r) => {
        let decision: string | undefined;
        // A daemon tick every 5 s, plus a tick that lands inside a gap while armed.
        if (t >= nextTickAt || (armed !== undefined && !r.isCoverageSufficient)) {
          nextTickAt = t + 5_000;
          const d = entryDecision(bad.provider, t, PEAK_SOL, armed);
          decision = d.outcome;
          if (d.outcome === "ARMED_FIRST_TICK") armed = d.retestResult.updatedArmedState;
          if (d.outcome === "BUY_GATE_REJECTED") armed = undefined;
        }
        badSamples.push({ t, r, ...(decision ? { decision } : {}) });
      },
    });
    expectExecutionInvariants(badReport.status);
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
      expect(span.windowEndMs % 1_000).toBe(0);
    }
    const decisions = badSamples.filter((x) => x.decision).map((x) => x.decision);
    expect(decisions).toContain("ARMED_FIRST_TICK");
    expect(decisions.slice(decisions.indexOf("ARMED_FIRST_TICK"))).toContain("BUY_GATE_REJECTED");
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
          const b = entryDecision(h.provider, t, PEAK_SOL * 0.88, armed);
          decisions.push(b.outcome);
          armed = undefined;
        }
      },
    });
    const s = report.status;
    expectExecutionInvariants(s);
    const retrievals = s.ledger.filter((e) => e.purpose === "TRANSACTION_RETRIEVAL");
    expect(retrievals).toHaveLength(3);
    const firstGetSlot = s.ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(retrievals.every((e) => e.dispatchedAtMs < firstGetSlot.dispatchedAtMs)).toBe(true);
    expect(decisions).toEqual(["ARMED_FIRST_TICK", "RETEST_CONFIRMED"]);
    const last = s.snapshots[s.snapshots.length - 1]!;
    expect(last.qualificationKind).toBe("QUIET_WINDOW");
    expect(h.provider.getSnapshotResult(last.id)!.underlyingOutcomes.knownAnchorSignature).toBe(
      SELL_1,
    );
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
    const aReport = await runUntil(a, 79_000, {
      everyMs: 100,
      onSample: (t, r) => {
        aSamples.push({ t, r });
        if (t === START_MS + 74_400) {
          frozenBefore = JSON.stringify(a.provider.getSnapshotResult(1));
          availableBeforeArrival = r.isCoverageSufficient;
        }
      },
    });
    expect(availableBeforeArrival).toBe(true);
    const snap1 = aReport.status.snapshots.find((x) => x.id === 1)!;
    expect(snap1.withdrawnReason).toBe("DELAYED_SIGNATURE_AT_OR_BEFORE_CUTOFF_SLOT");
    const arrival = a.deliveredAt.get(LATE)!;
    expect(arrival).toBe(START_MS + 74_500);
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

    // (c) A recorded gap (corrupt frame on the active subscription) withdraws every snapshot at once.
    const c = createHarness({ rawMessagesAtMs: [{ atMs: 76_000, data: "{not-json" }] });
    const cReport = await runUntil(c, 78_000);
    const withdrawn = cReport.status.snapshots.filter((x) => x.withdrawnAtMs === START_MS + 76_000);
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0]!.withdrawnReason).toContain("RECORDED_GAP:ACTIVE_SOURCE_CORRUPTION");
  });

  it("R6. Backlog, per-cycle retrieval allowance, refresh-time arrivals and failed transactions", async () => {
    const burst = Array.from({ length: 6 }, (_, i) => ({
      signature: sig(40 + i),
      atMs: 30_000,
      side: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
    }));
    const h = createHarness({ swaps: burst });
    const s1 = (await runUntil(h, 75_000)).status;
    expectExecutionInvariants(s1);
    expect(s1.ledger.filter((e) => e.purpose === "TRANSACTION_RETRIEVAL")).toHaveLength(6);
    expect(s1.cycleLog[0]!.outcome).toBe("REFRESH_SKIPPED_RETRIEVAL_ALLOWANCE_EXHAUSTED");
    expect(s1.cycleLog[0]!.retrievals).toBe(4);
    expect(s1.refreshesSkipped).toBe(1);
    const pub = s1.snapshots[0]!;
    expect(pub.qualificationKind).toBe("ACTIVE_WINDOW");
    expect([pub.recentBuys60s, pub.recentSells60s]).toEqual([3, 3]);

    const d = createHarness({
      swaps: [{ signature: sig(50), atMs: 68_500, side: "BUY", notifyDelayMs: 0 }],
    });
    const rd = await runUntil(d, 74_000);
    const firstRefresh = rd.status.cycleLog.find((c) => c.getSlotDispatchedAtMs !== null)!;
    expect(firstRefresh.outcome).not.toBe("PUBLISHED");
    expect(firstRefresh.outcome).toMatch(/PROCESSING_BACKLOG|notification received during refresh/);

    const f = createHarness({
      swaps: [
        { signature: sig(60), atMs: 30_000, side: "BUY", validFailure: true },
        { signature: sig(61), atMs: 35_000, side: "BUY" },
      ],
    });
    const fs = (await runUntil(f, 75_000)).status.snapshots[0]!;
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
    expectExecutionInvariants(s);
    expect(report.stopReason).toBe("RECONNECT_CEILING_REACHED");
    expect(s.reconnects).toBe(1);
    expect(s.deadlineMs).toBe(START_MS + 600_000);
    const anchors = s.ledger.filter((e) => e.purpose === "PRIOR_ANCHOR");
    expect(anchors).toHaveLength(2);
    const reAnchor = anchors[1]!.dispatchedAtMs;
    const nextSlot = s.ledger.find((e) => e.purpose === "GET_SLOT" && e.dispatchedAtMs > reAnchor)!;
    expect(nextSlot.dispatchedAtMs - reAnchor).toBeGreaterThanOrEqual(65_000);
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
    expectExecutionInvariants(pr.status);
    expect(pr.stopReason).toBe("RECONNECT_CEILING_REACHED");
    expect(pr.status.keepalive.matchedPongs).toBe(0);
    expect(pr.status.ledger.filter((e) => e.purpose === "PRIOR_ANCHOR")).toHaveLength(2);
    expect(pr.status.refreshesPublished).toBe(0);
  });

  it("R8. Shared ceilings stop collection exactly once without resets", async () => {
    const http = createHarness({ limits: { maxHttpAttempts: 12, maxTransactionRetrievals: 12 } });
    const hr = await runUntil(http, 300_000);
    expect(hr.stopReason).toBe("HTTP_ATTEMPT_CEILING_REACHED");
    expect(hr.status.httpAttempts).toBe(12);
    expectExecutionInvariants(hr.status);

    const many = Array.from({ length: 6 }, (_, i) => ({
      signature: sig(70 + i),
      atMs: 10_000 + i * 3_000,
      side: "BUY" as const,
    }));
    const nr = await runUntil(
      createHarness({ swaps: many, limits: { maxNotifications: 5 } }),
      300_000,
    );
    expect(nr.stopReason).toBe("NOTIFICATION_CEILING_REACHED");
    expectExecutionInvariants(nr.status);

    const rr = await runUntil(
      createHarness({ swaps: many, limits: { maxTransactionRetrievals: 3 } }),
      300_000,
    );
    expect(rr.stopReason).toBe("TRANSACTION_RETRIEVAL_CEILING_REACHED");
    expect(rr.status.transactionRetrievals).toBe(3);
    expectExecutionInvariants(rr.status);

    const wr = await runUntil(
      createHarness({ swaps: many, limits: { maxWsMessages: 3 } }),
      300_000,
    );
    expect(wr.stopReason).toBe("WS_MESSAGE_CEILING_REACHED");
    expect(wr.status.ws.messages).toBe(4);
    expectExecutionInvariants(wr.status);
  });

  it("R9. Simulated 600-second lifetime: exact deadline, pacing, no overlap, exact accounting, cleanup", async () => {
    const h = createHarness();
    const report = await drive(h.sched, h.provider.start());
    const s = report.status;
    expect(report.stopReason).toBe("LIFETIME_EXPIRED");
    expect(s.state).toBe("STOPPED");
    expect(s.stoppedAtMs).toBe(s.deadlineMs);
    expectExecutionInvariants(s);
    // Planning estimate (quiet): 2 setup requests + 3 per refresh, below the 300 ceiling.
    expect(s.httpAttempts).toBe(2 + 3 * s.refreshesAttempted);
    expect(s.httpAttempts).toBeLessThanOrEqual(218);
    expect(s.refreshesPublished).toBe(s.refreshesAttempted);
    expect(s.keepalive.pingsSent).toBeLessThanOrEqual(30);
    expect(s.keepalive.matchedPongs).toBe(s.keepalive.pingsSent);
    expect(
      s.snapshots.every((x) => x.withdrawnReason === "PROVIDER_STOPPED:LIFETIME_EXPIRED"),
    ).toBe(true);
    expect(s.snapshots.every((x) => x.withdrawnAtMs === s.deadlineMs)).toBe(true);
    expect(h.transports.every((t) => t.closed)).toBe(true);
    expect(h.sched.count("provider")).toBe(0);
    expect(read(h, h.clock()).diagnosticReason).toBe(
      "PAPER_ROLLING_FLOW_STOPPED: LIFETIME_EXPIRED",
    );
  });

  it("R10. Cancellation: stop() and an external abort cancel an in-flight request and close everything", async () => {
    const h = createHarness({ hangMethod: "getSlot" });
    const report = await runUntil(h, undefined, {
      everyMs: 250,
      onSample: () => {
        if (h.provider.getStatus().ledger.some((e) => e.purpose === "GET_SLOT")) {
          h.provider.stop("TEST_CANCEL");
        }
      },
    });
    expect(report.stopReason).toBe("TEST_CANCEL");
    const last = report.status.ledger[report.status.ledger.length - 1]!;
    expect(last.purpose).toBe("GET_SLOT");
    expect(last.error).toBe("REQUEST_ABORTED");
    expect(h.transports.every((t) => t.closed)).toBe(true);
    expectExecutionInvariants(report.status);

    const e = createHarness();
    const controller = new AbortController();
    e.sched.at(START_MS + 30_000, () => controller.abort(), true);
    const er = await runUntil(e, undefined, undefined, controller.signal);
    expect(er.stopReason).toBe("EXTERNAL_ABORT");
    expect(er.status.stoppedAtMs).toBe(START_MS + 30_000);
    expectExecutionInvariants(er.status);
  });

  it("R11. The absolute lifetime is enforced during requests, pacing waits, ack waits and body reads", async () => {
    // (a) In-flight request: a 2.25 s getBlockTime response cannot carry the session past 72 s.
    const a = createHarness({
      limits: { lifetimeMs: 72_000 },
      latencyFor: (m) => (m === "getBlockTime" ? 2_250 : undefined),
    });
    const ar = await drive(a.sched, a.provider.start());
    expect(ar.stopReason).toBe("LIFETIME_EXPIRED");
    expect(ar.status.stoppedAtMs).toBe(START_MS + 72_000);
    const aLast = ar.status.ledger[ar.status.ledger.length - 1]!;
    expect(aLast.purpose).toBe("GET_BLOCK_TIME");
    expect(aLast.completedAtMs).toBe(START_MS + 72_000);
    expect(aLast.error).toBe("REQUEST_ABORTED");
    expectExecutionInvariants(ar.status);
    expect(a.sched.count("provider")).toBe(0);

    // (b) Pacing wait: the deadline falls inside the GET_BLOCK_TIME pacing wait; nothing more is sent.
    const b = createHarness({ limits: { lifetimeMs: 69_000 } });
    const br = await drive(b.sched, b.provider.start());
    expect(br.status.stoppedAtMs).toBe(START_MS + 69_000);
    expect(br.status.ledger.map((e) => e.purpose)).toEqual([
      "POOL_LAYOUT",
      "PRIOR_ANCHOR",
      "GET_SLOT",
    ]);
    expectExecutionInvariants(br.status);

    // (c) Ack wait after a reconnect: the second subscription is never acknowledged.
    const c = createHarness({
      limits: { lifetimeMs: 70_000 },
      disconnectAtMs: [66_000],
      ackTransports: 1,
    });
    const cr = await drive(c.sched, c.provider.start());
    expect(cr.stopReason).toBe("LIFETIME_EXPIRED");
    expect(cr.status.stoppedAtMs).toBe(START_MS + 70_000);
    expect(cr.status.reconnects).toBe(1);
    expect(cr.status.ledger.filter((e) => e.purpose === "PRIOR_ANCHOR")).toHaveLength(2);
    expectExecutionInvariants(cr.status);

    // (d) Body read: headers arrive, the body stalls; the deadline aborts the read and cancels the stream.
    const stalls: { cancelled: boolean }[] = [];
    const d = createHarness({
      limits: { lifetimeMs: 72_000 },
      respond: (ctx) => {
        if (ctx.method !== "getBlockTime") return undefined;
        const body = stalledBody('{"jsonrpc":"2.0",');
        stalls.push(body.state);
        return new Response(body.stream, { status: 200 });
      },
    });
    const dr = await drive(d.sched, d.provider.start());
    expect(dr.status.stoppedAtMs).toBe(START_MS + 72_000);
    expect(dr.status.ledger[dr.status.ledger.length - 1]!.error).toBe("REQUEST_ABORTED");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stalls[0]!.cancelled).toBe(true);
    expectExecutionInvariants(dr.status);

    // (e) A published snapshot is withdrawn at the deadline itself.
    const e = createHarness({ limits: { lifetimeMs: 76_000 } });
    const er = await drive(e.sched, e.provider.start());
    expect(er.status.snapshots.length).toBeGreaterThan(0);
    expect(er.status.snapshots.every((x) => x.withdrawnAtMs === START_MS + 76_000)).toBe(true);
  });

  it("R12. A missing pong withdraws snapshots and aborts in-flight RPC work at the pong timeout", async () => {
    const h = createHarness({
      dropPongsAfterMs: 75_000,
      latencyFor: (m, now) => (m === "getSlot" && now >= START_MS + 88_000 ? 9_000 : undefined),
    });
    const report = await runUntil(h, 100_000);
    const s = report.status;
    expectExecutionInvariants(s);
    const obsStart = START_MS + 2_650;
    const pongTimeout = obsStart + 4 * 20_000 + 10_000; // 4th ping at +80 s unanswered
    const slow = s.ledger.find(
      (e) => e.purpose === "GET_SLOT" && e.dispatchedAtMs >= START_MS + 88_000,
    )!;
    expect(slow.dispatchedAtMs).toBeLessThan(pongTimeout);
    expect(slow.completedAtMs).toBe(pongTimeout); // aborted at the pong timeout, not at its own 5 s timeout
    expect(slow.error).toBe("REQUEST_ABORTED");
    const withdrawn = s.snapshots.filter(
      (x) => x.withdrawnReason === "EPOCH_INVALIDATED:MISSING_PONG",
    );
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn.every((x) => x.withdrawnAtMs === pongTimeout)).toBe(true);
    expect(s.reconnects).toBe(1);
  });

  it("R13. The first HTTP 429 is terminal from its headers; the shared budget manager is unchanged", async () => {
    const stalls: { cancelled: boolean }[] = [];
    const a = createHarness({
      respond: (ctx) => {
        if (ctx.method !== "getSlot") return undefined;
        const body = stalledBody("rate limited");
        stalls.push(body.state);
        return new Response(body.stream, { status: 429 });
      },
    });
    const ar = await drive(a.sched, a.provider.start());
    expect(ar.stopReason).toBe("HTTP_429_RECEIVED");
    const last = ar.status.ledger[ar.status.ledger.length - 1]!;
    expect(last.purpose).toBe("GET_SLOT");
    expect(last.httpStatus).toBe(429);
    expect(ar.status.stoppedAtMs).toBe(last.dispatchedAtMs + 100); // at headers; the body never ends
    expect(ar.status.httpAttempts).toBe(3);
    expect(a.counts().fetchCalls).toBe(3);
    expectExecutionInvariants(ar.status);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stalls[0]!.cancelled).toBe(true);

    const b = createHarness({
      swaps: [{ signature: sig(80), atMs: 20_000, side: "BUY" }],
      respond: (ctx) =>
        ctx.method === "getTransaction" ? new Response("{}", { status: 429 }) : undefined,
    });
    const br = await drive(b.sched, b.provider.start());
    expect(br.stopReason).toBe("HTTP_429_RECEIVED");
    expect(br.status.ledger[br.status.ledger.length - 1]!.purpose).toBe("TRANSACTION_RETRIEVAL");
    expect(b.counts().fetchCalls).toBe(br.status.httpAttempts);
    expectExecutionInvariants(br.status);

    // Other callers keep the shared three-consecutive-429 rule.
    const shared = new GlobalResourceBudgetManager();
    shared.recordResponseStatus(429);
    expect(shared.is429HaltRequired()).toBe(false);
    shared.recordResponseStatus(429);
    shared.recordResponseStatus(429);
    expect(shared.is429HaltRequired()).toBe(true);
  });

  it("R14. Bounded bodies and rejected redirects: oversized, declared-oversized, streaming, stalled, redirect", async () => {
    // (a) Oversized body: rejected, not terminal; the next refresh publishes.
    const big = createHarness({
      limits: { maxResponseBytes: 8_192 },
      respond: (ctx) =>
        ctx.method === "getBlockTime" && ctx.call === 1
          ? new Response(
              `{"jsonrpc":"2.0","id":${ctx.id},"result":1,"pad":"${"x".repeat(20_000)}"}`,
              {
                status: 200,
              },
            )
          : undefined,
    });
    const bigR = await runUntil(big, 85_000);
    expect(bigR.status.ledger.find((e) => e.purpose === "GET_BLOCK_TIME")!.error).toBe(
      "RESPONSE_TOO_LARGE",
    );
    expect(bigR.status.refreshesPublished).toBeGreaterThan(0);
    expectExecutionInvariants(bigR.status);

    // (b) Declared Content-Length above the ceiling: rejected before reading.
    const declared: { cancelled: boolean }[] = [];
    const dec = createHarness({
      limits: { maxResponseBytes: 8_192 },
      respond: (ctx) => {
        if (ctx.method !== "getSlot" || ctx.call !== 1) return undefined;
        const body = stalledBody("{");
        declared.push(body.state);
        return new Response(body.stream, { status: 200, headers: { "content-length": "999999" } });
      },
    });
    const decR = await runUntil(dec, 80_000);
    const decSlot = decR.status.ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(decSlot.error).toBe("RESPONSE_TOO_LARGE");
    expect(decSlot.completedAtMs).toBe(decSlot.dispatchedAtMs + 100);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(declared[0]!.cancelled).toBe(true);
    expectExecutionInvariants(decR.status);

    // (c) Streaming body delivered in three chunks over 300 virtual ms is assembled and used.
    const streaming = createHarness({
      respond: (ctx, sched) => {
        if (ctx.method !== "getBlockTime" || ctx.call !== 1) return undefined;
        const slotTimeSec = Math.floor(ctx.now / 1000) - 3;
        const text = JSON.stringify({ jsonrpc: "2.0", id: ctx.id, result: slotTimeSec });
        const parts = [text.slice(0, 5), text.slice(5, 15), text.slice(15)];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            parts.forEach((p, i) =>
              sched.add(
                () => {
                  controller.enqueue(encoder.encode(p));
                  if (i === parts.length - 1) controller.close();
                },
                100 * (i + 1),
                "harness",
              ),
            );
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    const stR = await runUntil(streaming, 80_000);
    const stBt = stR.status.ledger.find((e) => e.purpose === "GET_BLOCK_TIME")!;
    expect(stBt.error).toBeNull();
    expect(stBt.completedAtMs! - stBt.dispatchedAtMs).toBe(400);
    expect(stR.status.cycleLog[0]!.outcome).toBe("PUBLISHED");
    expectExecutionInvariants(stR.status);

    // (d) Stalled body: the per-request timeout aborts after exactly 5,000 ms and cancels the stream.
    const stalled: { cancelled: boolean }[] = [];
    const sl = createHarness({
      respond: (ctx) => {
        if (ctx.method !== "getSlot" || ctx.call !== 1) return undefined;
        const body = stalledBody('{"jsonrpc"');
        stalled.push(body.state);
        return new Response(body.stream, { status: 200 });
      },
    });
    const slR = await runUntil(sl, 85_000);
    const slSlot = slR.status.ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(slSlot.error).toBe("REQUEST_TIMED_OUT");
    expect(slSlot.completedAtMs! - slSlot.dispatchedAtMs).toBe(5_000);
    expect(slR.status.ledger.filter((e) => e.purpose === "GET_SLOT").length).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stalled[0]!.cancelled).toBe(true);
    expectExecutionInvariants(slR.status);

    // (e) Redirect: never followed, terminal, requested with redirect "manual".
    const rd = createHarness({
      respond: (ctx) =>
        ctx.method === "getAccountInfo"
          ? new Response(null, {
              status: 302,
              headers: { location: "http://127.0.0.1:9/elsewhere" },
            })
          : undefined,
    });
    const rdR = await drive(rd.sched, rd.provider.start());
    expect(rdR.stopReason).toBe("HTTP_REDIRECT_REJECTED");
    expect(rd.counts().fetchCalls).toBe(1);
    expect(rd.fetchLog[0]!.init?.redirect).toBe("manual");
    expect(rd.fetchLog.every((f) => f.url === TEST_RPC_URL)).toBe(true);
    expectExecutionInvariants(rdR.status);
  });

  it("R15. Admission is not a dispatch: a stop between admission and dispatch is not counted and settles", async () => {
    // Unit: admission checks without counting; only actual dispatches count.
    const budget = new PaperRollingDispatchBudget({
      maxTotalRequests: 5,
      maxEnrichmentAttempts: 5,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: 2_500,
      clock: () => START_MS,
    });
    expect(budget.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", START_MS)).toBe(true);
    expect(budget.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", START_MS)).toBe(true);
    expect(budget.getTotalRequests()).toBe(0);
    expect(budget.recordActualDispatch(START_MS)).toBe(true);
    expect(budget.getTotalRequests()).toBe(1);

    // Integration: stop injected inside the adapter's (retrieval) and the enumerator's (history) admission.
    const original = PaperRollingDispatchBudget.prototype.recordRequestAttempt;
    for (const scenario of ["RETRIEVAL", "HISTORY"] as const) {
      const h = createHarness(
        scenario === "RETRIEVAL"
          ? { swaps: [{ signature: sig(90), atMs: 20_000, side: "BUY" }] }
          : {},
      );
      let armedStop = true;
      const spy = vi
        .spyOn(PaperRollingDispatchBudget.prototype, "recordRequestAttempt")
        .mockImplementation(function (this: PaperRollingDispatchBudget, ...args) {
          const allowed = original.apply(this, args);
          if (allowed && armedStop) {
            armedStop = false;
            h.provider.stop("TEST_STOP_AFTER_ADMISSION");
          }
          return allowed;
        });
      try {
        const report = await drive(h.sched, h.provider.start());
        expect(report.stopReason).toBe("TEST_STOP_AFTER_ADMISSION");
        const purposes = report.status.ledger.map((e) => e.purpose);
        if (scenario === "RETRIEVAL") {
          expect(purposes).toEqual(["POOL_LAYOUT", "PRIOR_ANCHOR"]);
        } else {
          expect(purposes).toEqual(["POOL_LAYOUT", "PRIOR_ANCHOR", "GET_SLOT", "GET_BLOCK_TIME"]);
        }
        expect(h.counts().fetchCalls).toBe(report.status.httpAttempts);
        expectExecutionInvariants(report.status);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
