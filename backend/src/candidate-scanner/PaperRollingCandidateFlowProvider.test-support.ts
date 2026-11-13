/**
 * Shared offline test support for PaperRollingCandidateFlowProvider (synthetic; test-only).
 *
 * Moved unchanged from PaperRollingCandidateFlowProvider.test.ts so the PAPER entry integration tests
 * can drive the actual provider with the same deterministic virtual scheduler and in-memory HTTP and
 * WebSocket mocks. Every chain, transaction and timing value here is SYNTHETIC. No network or socket
 * is used. The limits are an OFFLINE TEST CONFIGURATION ONLY (§8.29), not approved for live use.
 */
import { expect } from "vitest";
import {
  PaperRollingCandidateFlowProvider,
  type PaperRollingFlowLimits,
  type PaperRollingFlowStatus,
} from "./PaperRollingCandidateFlowProvider.js";
import type { CandidateFlowResult } from "./CandidateFlowProvider.js";
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
import type { PaperRequestSession } from "./PaperRequestSession.js";

/** OFFLINE TEST CONFIGURATION ONLY (§8.29). Not approved for live execution. */
export const OFFLINE_TEST_LIMITS: PaperRollingFlowLimits = Object.freeze({
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

export const START_MS = 1_791_931_000_000; // SYNTHETIC
export const BASE_SLOT = 461_970_000; // SYNTHETIC
export const SLOT_MS = 400;
export const TEST_RPC_URL = "http://127.0.0.1:8899";
export const POOL_ID = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
export const MINT = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
export const WSOL = "So11111111111111111111111111111111111111112";
export const TARGET = Object.freeze({ poolAddress: POOL_ID, tokenMint: MINT });
export const POOL_CONTEXT = {
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
export const sig = (k: number) =>
  encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => (i * 31 + k * 17 + 1) % 256));
export const GENESIS_SIG = sig(1);

// ---------------------------------------------------------------------------------------------
// Deterministic virtual scheduler and driver
// ---------------------------------------------------------------------------------------------

export interface VirtualTimer {
  readonly id: number;
  readonly at: number;
  /** Late timers fire after ordinary timers due at the same instant (probes, test stops). */
  readonly late: boolean;
  readonly owner: "provider" | "harness";
  readonly fn: () => void;
}

export class VirtualScheduler {
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
export async function drive<T>(sched: VirtualScheduler, promise: Promise<T>): Promise<T> {
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

export interface SyntheticSwap {
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

export interface MockWs extends ISolanaKeepaliveWebSocketTransport {
  readonly subscriptionId: number;
  subscribed: boolean;
  closed: boolean;
  emitNotification(signature: string, slot: number): void;
  emitRaw(data: string): void;
  emitClose(): void;
}

export interface RespondContext {
  readonly method: string;
  readonly call: number;
  readonly id: number;
  readonly now: number;
}

export function txSlot(atMs: number): number {
  return BASE_SLOT + Math.floor(atMs / SLOT_MS);
}

export const encoder = new TextEncoder();

export function createHarness(
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
    /** Overrides the SYNTHETIC result of one Solana RPC call (return undefined for the default). */
    readonly rpcResult?: (
      method: string,
      params: readonly unknown[],
      now: number,
    ) => { readonly result: unknown } | undefined;
    /** Answers requests to hosts other than the SYNTHETIC RPC URL. */
    readonly otherHttp?: (ctx: {
      readonly url: string;
      readonly path: string;
      readonly init: RequestInit | undefined;
      readonly now: number;
    }) => Response | undefined;
    /** Builds a shared request session over the harness transport; the provider then uses it. */
    readonly session?: (deps: {
      readonly fetchFn: typeof fetch;
      readonly clock: () => number;
      readonly timers: {
        setTimeout(fn: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
      };
    }) => PaperRequestSession;
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
    const url = String(input);
    // RPC by origin (an RPC URL may carry a SYNTHETIC credential query); anything else is another host.
    if (new URL(url).origin !== new URL(TEST_RPC_URL).origin) {
      // Other SYNTHETIC hosts (security and spot providers), answered after the normal latency.
      const path = new URL(url).pathname;
      fetchLog.push({ method: `${init?.method ?? "GET"} ${path}`, init, url });
      const now = sched.now;
      await delay(opts.latencyFor?.(path, now) ?? latencyMs, init?.signal);
      return (
        opts.otherHttp?.({ url, path, init, now: sched.now }) ??
        new Response("SYNTHETIC: no route", { status: 404 })
      );
    }
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
    const override = opts.rpcResult?.(body.method, body.params, now);
    if (override !== undefined) {
      result = override.result;
    } else if (body.method === "getAccountInfo") {
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

  const timers = {
    setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
    clearTimeout: (handle: unknown) => sched.clear(handle),
  };
  const session = opts.session?.({ fetchFn, clock, timers });
  const provider = new PaperRollingCandidateFlowProvider({
    target: TARGET,
    executionContext: "PAPER_SIMULATION",
    rpcUrl: TEST_RPC_URL,
    ...(session ? { requestSession: session } : { fetchFn }),
    createWebSocketTransport: createWs,
    limits: { ...OFFLINE_TEST_LIMITS, ...(opts.limits ?? {}) },
    clock,
    timers,
  });

  return {
    provider,
    session,
    fetchFn,
    createWebSocketTransport: createWs,
    timers,
    sched,
    clock,
    transports,
    deliveredAt,
    fetchLog,
    counts: () => ({ fetchCalls: fetchLog.length, factoryCalls }),
  };
}

export type Harness = ReturnType<typeof createHarness>;

export const read = (h: Harness, t: number): CandidateFlowResult =>
  h.provider.getCandidateFlow(TARGET, t);

/** Starts collection, optionally stopping at `stopAtMs` (relative) and sampling reads every `everyMs`. */
export async function runUntil(
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
export function expectExecutionInvariants(status: PaperRollingFlowStatus) {
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
