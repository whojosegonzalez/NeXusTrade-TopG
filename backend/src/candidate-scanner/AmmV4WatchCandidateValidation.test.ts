/**
 * Watched candidate validation (offline). Positive discovery evidence is GENUINE collector output:
 * the reviewed BoundedAmmV4CreationWatch runs against a scripted in-memory transport on the shared
 * virtual scheduler. Negative cases clone that output and change one thing. Every response, key and
 * value is SYNTHETIC; no real network, socket or daemon.
 */
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  validateWatchedDiscoveryEvidence,
  evaluateWatchCandidateEvidence,
  executeWatchCandidateValidation,
  precheckExchangeFromEvidence,
  computeWatchValidationDeadline,
  PROVISIONAL_TARGET_DISCLAIMER,
  DEFAULT_WATCH_VALIDATION_LIMITS,
  REVIEWED_SUBSCRIPTION_PAYLOAD,
  type WatchCandidateValidationResult,
} from "./AmmV4WatchCandidateValidation.js";
import {
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  PLANNING_START_WINDOW,
  RPC_URL_PLACEHOLDER,
  type PrecheckExchange,
} from "../scripts/fresh-amm-v4-precheck.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import {
  BoundedAmmV4CreationWatch,
  type BoundedAmmV4CreationWatchResult,
} from "./BoundedAmmV4CreationWatch.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";
import type { PaperRequestExchangeEvidence } from "./PaperRequestSession.js";
import {
  START_MS,
  TEST_RPC_URL,
  VirtualScheduler,
  drive,
  initTransactionResult,
  marketResponse,
  POOL,
  MINT,
} from "../scripts/fresh-amm-v4-precheck.test-support.js";

/** Parsed or cloned JSON shapes, checked by the assertions. */
type Loose = ReturnType<typeof JSON.parse>;

const VALID_SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const VALID_SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";
const NOTIFY_AT = START_MS + 10_000;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** SYNTHETIC scripted WebSocket transport (in memory). */
class ScriptedTransport implements ISolanaKeepaliveWebSocketTransport {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((...args: never[]) => void)[]> = {};

  on = ((event: string, listener: (...args: never[]) => void) => {
    (this.listeners[event] ??= []).push(listener);
  }) as ISolanaKeepaliveWebSocketTransport["on"];

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  ping(data?: Buffer): void {
    for (const l of this.listeners.pong ?? []) (l as (d: Buffer) => void)(data ?? Buffer.alloc(0));
  }
  open(): void {
    this.readyState = 1;
    for (const l of this.listeners.open ?? []) (l as () => void)();
  }
  message(data: string | Buffer): void {
    for (const l of this.listeners.message ?? []) (l as (d: string | Buffer) => void)(data);
  }
}

const ACK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 });
function notificationFrame(
  o: {
    subscription?: number;
    slot?: number;
    signature?: string;
    err?: unknown;
    jsonrpc?: string;
  } = {},
): string {
  return JSON.stringify({
    jsonrpc: o.jsonrpc ?? "2.0",
    method: "logsNotification",
    params: {
      subscription: o.subscription ?? 42,
      result: {
        context: { slot: o.slot ?? 250_000 },
        value: {
          err: o.err === undefined ? null : o.err,
          signature: o.signature ?? VALID_SIG_A,
          logs: ["Program log: initialize2"],
        },
      },
    },
  });
}
const DEFAULT_SCRIPT = [
  { atMs: 600, data: ACK },
  { atMs: 10_000, data: notificationFrame() },
];

/** Runs the REVIEWED collector against a scripted transport and returns its genuine result. */
async function captureWatch(script: readonly { atMs: number; data: string }[] = DEFAULT_SCRIPT) {
  const sched = new VirtualScheduler(START_MS);
  const transport = new ScriptedTransport();
  const watch = new BoundedAmmV4CreationWatch({
    wssUrl: "wss://synthetic.invalid/watch",
    clock: () => sched.now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "harness"),
      clearTimeout: (h: unknown) => sched.clear(h),
    },
    transportFactory: () => transport,
  });
  const running = watch.start();
  transport.open();
  for (const s of script) sched.at(START_MS + s.atMs, () => transport.message(s.data));
  const watchResult = await drive(sched, running);
  const timers = {
    setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
    clearTimeout: (h: unknown) => sched.clear(h),
  };
  return { sched, timers, watchResult, transport };
}

const advanceTo = (sched: VirtualScheduler, atMs: number) =>
  drive(sched, new Promise<void>((resolve) => sched.at(atMs, resolve)));

/** A mutable clone of genuine (deep-frozen) collector output. */
function tamper(
  r: BoundedAmmV4CreationWatchResult,
  edit: (x: Loose) => void,
): BoundedAmmV4CreationWatchResult {
  const copy = structuredClone(r) as Loose;
  edit(copy);
  return copy as BoundedAmmV4CreationWatchResult;
}

/** Recomputes the collector's message and byte counters from the frames (isolates other defects). */
function recount(x: Loose): void {
  const incoming = (x.observations.applicationFrames as Loose[]).filter(
    (f) => f.direction === "INCOMING",
  );
  x.observations.messagesReceivedCount = incoming.length;
  x.observations.payloadBytesReceived = incoming.reduce(
    (n: number, f: Loose) => n + (f.byteLength as number),
    0,
  );
}

function setPayload(x: Loose, index: number, payload: string): void {
  const f = x.observations.applicationFrames[index];
  f.payload = payload;
  f.byteLength = Buffer.byteLength(payload, "utf8");
  recount(x);
}

function makeMockFetch(
  sched: VirtualScheduler,
  options?: {
    rpcStatus?: number;
    rpcResponse?: unknown;
    marketStatus?: number;
    marketResponse?: unknown;
    marketRawBody?: Buffer;
    delayMs?: number;
    onCall?: (info: { url: string; method: string; body: unknown }) => void;
  },
) {
  const delay = (signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), options?.delayMs ?? 100, "harness");
      signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const isRpc = url.startsWith(TEST_RPC_URL);
    let parsedBody: unknown = null;
    if (init?.body) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = String(init.body);
      }
    }
    options?.onCall?.({ url, method: init?.method ?? "GET", body: parsedBody });
    await delay(init?.signal);

    if (isRpc) {
      const status = options?.rpcStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "RPC error" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const reqId = (parsedBody as { id?: number } | null)?.id ?? 1;
      const resp = options?.rpcResponse ?? {
        jsonrpc: "2.0",
        id: reqId,
        result: initTransactionResult({
          signature: VALID_SIG_A,
          slot: 250_000,
          blockTime: Math.floor(START_MS / 1000) - 300,
          openTime: Math.floor(START_MS / 1000) - 290,
        }),
      };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const status = options?.marketStatus ?? 200;
    if (status !== 200) return new Response("Market error", { status });
    if (options?.marketRawBody)
      return new Response(new Uint8Array(options.marketRawBody), { status: 200 });
    const resp = options?.marketResponse ?? marketResponse(START_MS - 300_000);
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

type Env = Awaited<ReturnType<typeof captureWatch>>;
function validate(
  env: Env,
  extra: Partial<Parameters<typeof executeWatchCandidateValidation>[0]> & {
    fetchFn: typeof fetch;
  },
): Promise<WatchCandidateValidationResult> {
  return drive(
    env.sched,
    executeWatchCandidateValidation({
      watchResult: env.watchResult,
      rpcUrl: `${TEST_RPC_URL}/?key=SYNTHETIC-secret-key-123`,
      clock: () => env.sched.now,
      timers: env.timers,
      ...extra,
    }),
  );
}

/** An AbortController whose currently registered abort listeners can be counted. */
function trackedController() {
  const controller = new AbortController();
  const signal = controller.signal;
  const registered = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: unknown, opts?: unknown) => {
    if (type === "abort") registered.add(listener);
    add(type, listener as EventListener, opts as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: unknown, opts?: unknown) => {
    if (type === "abort") registered.delete(listener);
    remove(type, listener as EventListener, opts as EventListenerOptions);
  }) as typeof signal.removeEventListener;
  return { controller, registered };
}

describe("AmmV4WatchCandidateValidation", () => {
  it("TC-V01: genuine collector evidence validates to TARGET_SELECTED with distinct timestamps and exactly 2 HTTP requests", async () => {
    const env = await captureWatch();
    // The positive fixture is real collector output.
    expect(env.watchResult.status).toBe("NOTIFICATION_CAPTURED");
    expect(env.transport.sent).toEqual([REVIEWED_SUBSCRIPTION_PAYLOAD]);

    const calls: { url: string; method: string }[] = [];
    const result = await validate(env, {
      fetchFn: makeMockFetch(env.sched, { onCall: (c) => calls.push(c) }),
    });

    expect(result).toMatchObject({ ok: true, outcome: "TARGET_SELECTED", httpAttempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(TEST_RPC_URL);
    expect(calls[1]!.url).toContain("https://api.dexscreener.com/latest/dex/tokens/");
    expect(result.validationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);

    const target = result.target!;
    expect(target).toMatchObject({
      poolId: POOL,
      mintAddress: MINT,
      quoteMint: WSOL_MINT,
      orientation: "CANDIDATE_BASE_WSOL_QUOTE",
      eligibility: PROVISIONAL_TARGET_DISCLAIMER,
    });
    expect(target.initialization).toMatchObject({
      signature: VALID_SIG_A,
      slot: 250_000,
      transactionBlockTimeSec: Math.floor(START_MS / 1000) - 300,
      instructionRequestedOpenTimeSec: Math.floor(START_MS / 1000) - 290,
    });
    expect(target.market.pairCreatedAtMs).toBe(START_MS - 300_000);
    expect(target.market.runnerOpenTimeSec).toBe(Math.floor((START_MS - 300_000) / 1000));
    expect(target.startWindow).toMatchObject({
      basis: PLANNING_START_WINDOW.basis,
      minAgeSec: PLANNING_START_WINDOW.minAgeSec,
      maxAgeSec: PLANNING_START_WINDOW.maxAgeSec,
    });
    expect(DEFAULT_WATCH_VALIDATION_LIMITS).toMatchObject({
      validationWindowMs: 30_000,
      maxHttpAttempts: 2,
    });

    const direct = validateWatchedDiscoveryEvidence(env.watchResult);
    expect(direct).toMatchObject({
      ok: true,
      discovery: {
        signature: VALID_SIG_A,
        subscriptionId: 42,
        notificationReceivedAtMs: NOTIFY_AT,
        watchStartedAtMs: START_MS,
      },
    });
    expect(result.exchanges.map((e) => e.purpose)).toEqual([
      "PRECHECK_TRANSACTION",
      "PRECHECK_MARKET",
    ]);
    expect(result.exchanges[0]!.request.url).toBe(RPC_URL_PLACEHOLDER);
    expect(JSON.stringify(result).includes("SYNTHETIC-secret-key-123")).toBe(false);
  });

  it("TC-V02: pre-send rejection on unsuitable watch status or null notification with zero HTTP sends", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(env.sched, { onCall: (c) => calls.push(c) });
    for (const watchResult of [
      tamper(env.watchResult, (x) => {
        x.status = "KEEPALIVE_TIMEOUT";
      }),
      tamper(env.watchResult, (x) => {
        x.notification = null;
      }),
    ]) {
      const r = await validate({ ...env, watchResult }, { fetchFn });
      expect(r).toMatchObject({
        ok: false,
        outcome: "DISCOVERY_EVIDENCE_INVALID",
        httpAttempts: 0,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("TC-V03: pre-send rejection on tampered discovery frames and metadata with zero HTTP sends", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(env.sched, { onCall: (c) => calls.push(c) });
    const cases: [string, BoundedAmmV4CreationWatchResult, string][] = [
      [
        "other fee destination",
        tamper(env.watchResult, (x) =>
          setPayload(
            x,
            0,
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "logsSubscribe",
              params: [
                { mentions: ["11111111111111111111111111111111"] },
                { commitment: "confirmed" },
              ],
            }),
          ),
        ),
        "DISCOVERY_TAMPERED",
      ],
      [
        "observation subscription id",
        tamper(env.watchResult, (x) => {
          x.observations.subscriptionId = 999;
        }),
        "DISCOVERY_TAMPERED",
      ],
      [
        "failed last notification",
        tamper(env.watchResult, (x) =>
          setPayload(x, 2, notificationFrame({ err: { InstructionError: [0, "Custom"] } })),
        ),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "metadata signature",
        tamper(env.watchResult, (x) => {
          x.notification.signature = VALID_SIG_B;
        }),
        "DISCOVERY_TAMPERED",
      ],
      [
        "metadata slot",
        tamper(env.watchResult, (x) => {
          x.notification.slot = 999_999;
        }),
        "DISCOVERY_TAMPERED",
      ],
    ];
    for (const [label, watchResult, outcome] of cases) {
      const r = await validate({ ...env, watchResult }, { fetchFn });
      expect(r.outcome, label).toBe(outcome);
      expect(r.httpAttempts, label).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  it("TC-V04: pre-send rejection on collector cleanup failure with zero HTTP sends", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const r = await validate(
      {
        ...env,
        watchResult: tamper(env.watchResult, (x) => {
          x.observations.cleanupFailed = true;
          x.observations.cleanupFailureReason = "SYNTHETIC close failure";
        }),
      },
      { fetchFn: makeMockFetch(env.sched, { onCall: (c) => calls.push(c) }) },
    );
    expect(r).toMatchObject({ outcome: "DISCOVERY_EVIDENCE_INVALID", httpAttempts: 0 });
    expect(calls).toHaveLength(0);
  });

  it("TC-V05: pre-send rejection on an expired validation deadline (receipt + 30 s from the frame)", async () => {
    const env = await captureWatch();
    await advanceTo(env.sched, NOTIFY_AT + 30_000);
    const calls: unknown[] = [];
    const r = await validate(env, {
      fetchFn: makeMockFetch(env.sched, { onCall: (c) => calls.push(c) }),
    });
    expect(r).toMatchObject({
      outcome: "VALIDATION_DEADLINE_EXPIRED",
      httpAttempts: 0,
      validationDeadlineAtMs: NOTIFY_AT + 30_000,
    });
    expect(calls).toHaveLength(0);
    expect(env.sched.count("provider")).toBe(0);
  });

  it("TC-V06: Solana RPC failure halts with exactly 1 attempt and zero DexScreener calls", async () => {
    const env = await captureWatch();
    const calls: { url: string }[] = [];
    const r = await validate(env, {
      fetchFn: makeMockFetch(env.sched, { rpcStatus: 500, onCall: (c) => calls.push(c) }),
    });
    expect(r).toMatchObject({ ok: false, outcome: "TRANSACTION_REQUEST_FAILED", httpAttempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(TEST_RPC_URL);
  });

  it("TC-V07: a non-matching transaction halts with exactly 1 attempt", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const r = await validate(env, {
      fetchFn: makeMockFetch(env.sched, {
        rpcResponse: {
          jsonrpc: "2.0",
          id: 1,
          result: initTransactionResult({
            signature: VALID_SIG_A,
            slot: 250_000,
            blockTime: Math.floor(START_MS / 1000) - 300,
            feeDestination: "11111111111111111111111111111111",
          }),
        },
        onCall: (c) => calls.push(c),
      }),
    });
    expect(r).toMatchObject({ ok: false, outcome: "TRANSACTION_NONMATCH", httpAttempts: 1 });
    expect(r.reason).toContain("FEE_DESTINATION_MISMATCH");
    expect(calls).toHaveLength(1);
  });

  it("TC-V08: market request failure or non-match halts after 2 attempts", async () => {
    const a = await captureWatch();
    expect(
      await validate(a, { fetchFn: makeMockFetch(a.sched, { marketStatus: 500 }) }),
    ).toMatchObject({ outcome: "MARKET_REQUEST_FAILED", httpAttempts: 2 });
    const b = await captureWatch();
    expect(
      await validate(b, {
        fetchFn: makeMockFetch(b.sched, { marketResponse: { schemaVersion: "1.0.0", pairs: [] } }),
      }),
    ).toMatchObject({ outcome: "MARKET_NONMATCH", reason: "NO_PAIRS", httpAttempts: 2 });
  });

  it("TC-V09: a closed start window preserves the candidate target with a false outcome", async () => {
    const env = await captureWatch();
    const oldPairCreatedAtMs = START_MS - 800_000;
    const r = await validate(env, {
      fetchFn: makeMockFetch(env.sched, { marketResponse: marketResponse(oldPairCreatedAtMs) }),
    });
    expect(r).toMatchObject({
      ok: false,
      outcome: "START_WINDOW_ALREADY_CLOSED",
      reason: "PAIR_CREATED_AT_AGE_BEYOND_WINDOW",
      httpAttempts: 2,
    });
    expect(r.target!.market.pairCreatedAtMs).toBe(oldPairCreatedAtMs);
  });

  it("TC-V10: the first 429 halts dispatch immediately", async () => {
    const env = await captureWatch();
    const calls: string[] = [];
    const fetchFn = (async (input: unknown): Promise<Response> => {
      calls.push(String(input));
      await new Promise<void>((resolve) => env.sched.add(() => resolve(), 100, "harness"));
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "5" } });
    }) as unknown as typeof fetch;
    const r = await validate(env, { fetchFn });
    expect(r).toMatchObject({ outcome: "TRANSACTION_REQUEST_FAILED", httpAttempts: 1 });
    expect(r.reason).toBe("REQUEST_FAILED:HTTP_429_RECEIVED");
    expect(calls).toHaveLength(1);
    expect(env.sched.count("provider")).toBe(0);
  });

  it("TC-V11: an operator abort before dispatch sends nothing", async () => {
    const env = await captureWatch();
    const { controller, registered } = trackedController();
    controller.abort();
    const calls: unknown[] = [];
    const r = await validate(env, {
      fetchFn: makeMockFetch(env.sched, { onCall: (c) => calls.push(c) }),
      abortSignal: controller.signal,
    });
    expect(r).toMatchObject({ outcome: "OPERATOR_CANCELLED", httpAttempts: 0 });
    expect(calls).toHaveLength(0);
    expect(registered.size).toBe(0);
    expect(env.sched.count("provider")).toBe(0);
  });

  it("TC-V12: offline pure derivation reproduces the live result from recorded evidence", async () => {
    const env = await captureWatch();
    const live = await validate(env, { fetchFn: makeMockFetch(env.sched) });
    expect(live.ok).toBe(true);
    const pure = evaluateWatchCandidateEvidence(live.discovery!, live.exchanges);
    expect(pure.outcome).toBe(live.outcome);
    expect(pure.target).toEqual(live.target);
  });
});

describe("AmmV4WatchCandidateValidation hardening (review of 5ec9ee8)", () => {
  it("TC-V13: receipt time comes from the retained frame; substituted, future or inconsistent timestamps are rejected before sending", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(env.sched, { onCall: (c) => calls.push(c) });

    // The reviewer's reproduction: only notification.receivedAtMs moved to +70 s; started at +40 s.
    await advanceTo(env.sched, START_MS + 40_000 - 1);
    const substituted = tamper(env.watchResult, (x) => {
      x.notification.receivedAtMs = START_MS + 70_000;
    });
    expect(await validate({ ...env, watchResult: substituted }, { fetchFn })).toMatchObject({
      outcome: "DISCOVERY_TAMPERED",
      httpAttempts: 0,
    });

    // Every summary field shifted consistently: the retained frame still says +10 s.
    const shifted = tamper(env.watchResult, (x) => {
      const t = START_MS + 70_000;
      x.notification.receivedAtMs = t;
      x.observations.endedAtMs = t;
      x.observations.durationMs = t - START_MS;
      for (const e of x.observations.events as Loose[]) {
        if (e.type === "NOTIFICATION_QUALIFYING") e.details.receivedAtMs = t;
        if (e.type === "WATCH_TERMINATED") e.details.endedAtMs = t;
      }
    });
    expect(validateWatchedDiscoveryEvidence(shifted)).toMatchObject({
      ok: false,
      status: "DISCOVERY_TAMPERED",
    });
    expect(calls).toHaveLength(0);

    // Future evidence relative to the validation clock is rejected.
    expect(
      validateWatchedDiscoveryEvidence(env.watchResult, { nowMs: NOTIFY_AT - 1 }),
    ).toMatchObject({ ok: false, status: "DISCOVERY_EVIDENCE_INVALID" });

    // The deadline is the strictest of the evidence-derived and caller limits.
    const discovery = (validateWatchedDiscoveryEvidence(env.watchResult) as Loose).discovery;
    expect(computeWatchValidationDeadline(discovery)).toBe(NOTIFY_AT + 30_000);
    expect(
      computeWatchValidationDeadline(discovery, { limits: { validationWindowMs: 60_000 } }),
    ).toBe(NOTIFY_AT + 30_000); // loosening is capped
    expect(
      computeWatchValidationDeadline(discovery, { overallDeadlineAtMs: NOTIFY_AT + 5_000 }),
    ).toBe(NOTIFY_AT + 5_000);
    expect(() =>
      computeWatchValidationDeadline(discovery, { limits: { maxHttpAttempts: 0 } }),
    ).toThrow(/WATCH_VALIDATION_CONFIG_INVALID/);

    // With genuine evidence the run proceeds until exactly receipt + 30 s.
    const fresh = await captureWatch();
    await advanceTo(fresh.sched, NOTIFY_AT + 30_000 - 1);
    const late = await validate(fresh, { fetchFn: makeMockFetch(fresh.sched, { delayMs: 10 }) });
    expect(late.validationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);
    expect(late.outcome).toBe("VALIDATION_DEADLINE_EXPIRED");
    expect(late.httpAttempts).toBe(1); // dispatched, then cut off at the deadline
    expect(fresh.sched.count("provider")).toBe(0);
  });

  it("TC-V14: discovery verification rejects histories the reviewed collector could not have produced", async () => {
    const env = await captureWatch();
    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(env.sched, { onCall: (c) => calls.push(c) });
    const cases: [string, BoundedAmmV4CreationWatchResult, string][] = [
      [
        "extra mention and processed commitment",
        tamper(env.watchResult, (x) =>
          setPayload(
            x,
            0,
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "logsSubscribe",
              params: [
                {
                  mentions: [
                    RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
                    "11111111111111111111111111111111",
                  ],
                },
                { commitment: "processed" },
              ],
            }),
          ),
        ),
        "DISCOVERY_TAMPERED",
      ],
      [
        "overflow frame before the acknowledgement",
        tamper(env.watchResult, (x) => {
          x.observations.applicationFrames.splice(1, 0, {
            direction: "INCOMING",
            timestampMs: START_MS + 300,
            byteLength: 2_000_000,
            payload: null,
            isComplete: false,
            overflow: true,
            overflowReason: "PAYLOAD_BYTE_CEILING_EXCEEDED",
          });
          recount(x);
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "second outgoing frame",
        tamper(env.watchResult, (x) => {
          x.observations.applicationFrames.splice(2, 0, {
            ...x.observations.applicationFrames[0],
            timestampMs: START_MS + 700,
          });
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "terminating frame between acknowledgement and notification",
        tamper(env.watchResult, (x) => {
          const payload = notificationFrame({ jsonrpc: "1.0" });
          x.observations.applicationFrames.splice(2, 0, {
            direction: "INCOMING",
            timestampMs: START_MS + 5_000,
            byteLength: Buffer.byteLength(payload),
            payload,
            isComplete: true,
          });
          recount(x);
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "earlier qualifying notification",
        tamper(env.watchResult, (x) => {
          const payload = notificationFrame({ signature: VALID_SIG_B });
          x.observations.applicationFrames.splice(2, 0, {
            direction: "INCOMING",
            timestampMs: START_MS + 5_000,
            byteLength: Buffer.byteLength(payload),
            payload,
            isComplete: true,
          });
          recount(x);
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "byte length not the payload's",
        tamper(env.watchResult, (x) => {
          x.observations.applicationFrames[2].byteLength += 1;
          recount(x);
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "message counter",
        tamper(env.watchResult, (x) => {
          x.observations.messagesReceivedCount += 1;
        }),
        "DISCOVERY_TAMPERED",
      ],
      [
        "late acknowledgement",
        tamper(env.watchResult, (x) => {
          x.observations.applicationFrames[1].timestampMs = START_MS + 5_000;
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "frames out of order",
        tamper(env.watchResult, (x) => {
          x.observations.applicationFrames[1].timestampMs = START_MS + 9_000;
          x.observations.applicationFrames[2].timestampMs = START_MS + 8_000;
        }),
        "DISCOVERY_EVIDENCE_INVALID",
      ],
      [
        "missing capture event",
        tamper(env.watchResult, (x) => {
          x.observations.events = (x.observations.events as Loose[]).filter(
            (e) => e.type !== "NOTIFICATION_QUALIFYING",
          );
        }),
        "DISCOVERY_TAMPERED",
      ],
    ];
    for (const [label, watchResult, outcome] of cases) {
      const r = await validate({ ...env, watchResult }, { fetchFn });
      expect(r.outcome, label).toBe(outcome);
      expect(r.httpAttempts, label).toBe(0);
    }
    expect(calls).toHaveLength(0);

    // Positive: a genuine history with ignored, rejected and failed frames before the capture.
    const busy = await captureWatch([
      { atMs: 600, data: ACK },
      {
        atMs: 2_000,
        data: JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: {} }),
      },
      { atMs: 3_000, data: notificationFrame({ subscription: 7 }) },
      { atMs: 4_000, data: notificationFrame({ err: { InstructionError: [0, "Custom"] } }) },
      { atMs: 10_000, data: notificationFrame() },
    ]);
    expect(busy.watchResult.observations).toMatchObject({
      messagesReceivedCount: 5,
      rejectedNotificationsCount: 1,
      failedNotificationsCount: 1,
    });
    expect(validateWatchedDiscoveryEvidence(busy.watchResult).ok).toBe(true);
    expect(await validate(busy, { fetchFn: makeMockFetch(busy.sched) })).toMatchObject({
      outcome: "TARGET_SELECTED",
    });
  });

  it("TC-V15: the owned session is stopped and its listener removed on every exit; in-flight cancellation is classified as operator cancellation", async () => {
    // Success.
    const ok = await captureWatch();
    const a = trackedController();
    const success = await validate(ok, {
      fetchFn: makeMockFetch(ok.sched),
      abortSignal: a.controller.signal,
    });
    expect(success.outcome).toBe("TARGET_SELECTED");
    expect(ok.sched.count("provider")).toBe(0);
    expect(a.registered.size).toBe(0);

    // Request failure.
    const failing = await captureWatch();
    const b = trackedController();
    expect(
      (
        await validate(failing, {
          fetchFn: makeMockFetch(failing.sched, { rpcStatus: 500 }),
          abortSignal: b.controller.signal,
        })
      ).outcome,
    ).toBe("TRANSACTION_REQUEST_FAILED");
    expect(failing.sched.count("provider")).toBe(0);
    expect(b.registered.size).toBe(0);

    // Operator cancellation while the RPC request is in flight.
    const inflight = await captureWatch();
    const c = trackedController();
    inflight.sched.at(NOTIFY_AT + 50, () => c.controller.abort());
    const calls: string[] = [];
    const cancelled = await validate(inflight, {
      fetchFn: makeMockFetch(inflight.sched, { onCall: (x) => calls.push(x.url) }),
      abortSignal: c.controller.signal,
    });
    expect(cancelled).toMatchObject({ ok: false, outcome: "OPERATOR_CANCELLED", httpAttempts: 1 });
    expect(cancelled.reason).toBe("OPERATOR_CANCELLED: REQUEST_ABORTED");
    expect(cancelled.exchanges).toHaveLength(1);
    expect(cancelled.exchanges[0]).toMatchObject({
      purpose: "PRECHECK_TRANSACTION",
      error: "REQUEST_ABORTED",
    });
    expect(calls).toHaveLength(1); // no market request
    expect(inflight.sched.count("provider")).toBe(0);
    expect(c.registered.size).toBe(0);
  });

  it("TC-V16: pure derivation enforces the request, ordering, identity and deadline rules of acquisition", async () => {
    const env = await captureWatch();
    const live = await validate(env, { fetchFn: makeMockFetch(env.sched) });
    expect(live.outcome).toBe("TARGET_SELECTED");
    const d = live.discovery!;
    const [tx, market] = live.exchanges as PrecheckExchange[];
    const edit = (ex: PrecheckExchange, change: (x: Loose) => void): PrecheckExchange => {
      const copy = structuredClone(ex) as Loose;
      change(copy);
      return copy;
    };
    const cases: [
      string,
      PrecheckExchange[],
      string,
      Parameters<typeof evaluateWatchCandidateEvidence>[2]?,
    ][] = [
      [
        "duplicate third market exchange",
        [tx!, market!, edit(market!, (x) => (x.seq = 3))],
        "REQUEST_BOUND_EXCEEDED",
      ],
      ["duplicate sequence", [tx!, edit(market!, (x) => (x.seq = 1))], "EXCHANGE_SEQUENCE_INVALID"],
      [
        "market completed 60 s after receipt",
        [tx!, edit(market!, (x) => (x.completedAtMs = d.notificationReceivedAtMs + 60_000))],
        "EXCHANGE_2_AFTER_VALIDATION_DEADLINE",
      ],
      [
        "out of order",
        [edit(market!, (x) => (x.seq = 1)), edit(tx!, (x) => (x.seq = 2))],
        "TRANSACTION_REQUEST_IDENTITY_INVALID",
      ],
      [
        "transaction for another signature",
        [edit(tx!, (x) => (x.request.rpcParams[0] = VALID_SIG_B)), market!],
        "TRANSACTION_REQUEST_IDENTITY_INVALID",
      ],
      [
        "unredacted RPC URL",
        [edit(tx!, (x) => (x.request.url = TEST_RPC_URL)), market!],
        "TRANSACTION_REQUEST_IDENTITY_INVALID",
      ],
      [
        "market before transaction completed",
        [tx!, edit(market!, (x) => (x.dispatchedAtMs = (tx!.completedAtMs as number) - 1))],
        "MARKET_REQUEST_BEFORE_TRANSACTION_COMPLETED",
      ],
      [
        "transaction before the notification",
        [edit(tx!, (x) => (x.dispatchedAtMs = d.notificationReceivedAtMs - 1)), market!],
        "EXCHANGE_1_DISPATCHED_BEFORE_NOTIFICATION",
      ],
      [
        "market after a failed transaction",
        [edit(tx!, (x) => (x.httpStatus = 500)), market!],
        "MARKET_REQUEST_WITHOUT_QUALIFIED_TRANSACTION",
      ],
      [
        "market for another mint",
        [
          tx!,
          edit(
            market!,
            (x) => (x.request.url = "https://api.dexscreener.com/latest/dex/tokens/other"),
          ),
        ],
        "MARKET_REQUEST_NOT_FOR_DECODED_MINT",
      ],
      [
        "caller deadline before market completion",
        [tx!, market!],
        "EXCHANGE_2_AFTER_VALIDATION_DEADLINE",
        { overallDeadlineAtMs: (market!.completedAtMs as number) - 1 },
      ],
    ];
    for (const [label, exchanges, reason, context] of cases) {
      expect(evaluateWatchCandidateEvidence(d, exchanges, context), label).toMatchObject({
        ok: false,
        outcome: "EXCHANGE_EVIDENCE_INVALID",
        reason,
        target: null,
      });
    }
    // The untouched evidence still reproduces the live selection.
    expect(evaluateWatchCandidateEvidence(d, [tx!, market!]).target).toEqual(live.target);
  });

  it("TC-V17: non-UTF-8 response bytes are preserved losslessly and never qualify as JSON", async () => {
    const bytes = Buffer.from([255, 65, 66]);
    const evidence = (body: Buffer, bodyState: "COMPLETE" | "PARTIAL_OVERFLOW" = "COMPLETE") =>
      ({
        entry: {
          seq: 2,
          lane: "DEXSCREENER",
          owner: "SPOT",
          purpose: "PRECHECK_MARKET",
          requestedIdentity: MINT,
          jsonRpcId: null,
          dispatchedAtMs: NOTIFY_AT,
          completedAtMs: NOTIFY_AT + 50,
          httpStatus: 200,
          bodyComplete: bodyState === "COMPLETE",
          error: bodyState === "COMPLETE" ? null : "RESPONSE_TOO_LARGE",
        },
        method: "GET",
        url: "https://api.dexscreener.com/latest/dex/tokens/x",
        requestBody: null,
        responseHeaders: {},
        bodyState,
        body,
        observedBodyBytes: bodyState === "COMPLETE" ? body.length : body.length + 10,
        maxResponseBytes: 1_048_576,
      }) as PaperRequestExchangeEvidence;

    const nonText = precheckExchangeFromEvidence(evidence(bytes));
    expect(nonText.response).toMatchObject({
      bodyEncoding: "base64",
      retainedBytes: 3,
      storedBytes: 3,
      reproducesReceivedDigest: true,
      receivedDigestScope: "ORIGINAL_COMPLETE_BODY_BYTES",
    });
    const decoded = Buffer.from(nonText.response.body!, "base64");
    expect(decoded.equals(bytes)).toBe(true);
    expect(sha256(decoded)).toBe(nonText.response.receivedBytesSha256);

    const text = precheckExchangeFromEvidence(evidence(Buffer.from('{"a":"é"}', "utf8")));
    expect(text.response.bodyEncoding).toBe("utf8");
    expect(sha256(Buffer.from(text.response.body!, "utf8"))).toBe(
      text.response.receivedBytesSha256,
    );

    const partial = precheckExchangeFromEvidence(
      evidence(Buffer.from('{"a":', "utf8"), "PARTIAL_OVERFLOW"),
    );
    expect(partial.response).toMatchObject({
      completeEvidence: false,
      receivedDigestScope: "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
      observedBytes: 15,
    });

    // End to end: a non-UTF-8 market body is unusable evidence, not JSON.
    const env = await captureWatch();
    const r = await validate(env, { fetchFn: makeMockFetch(env.sched, { marketRawBody: bytes }) });
    expect(r).toMatchObject({ outcome: "MARKET_EVIDENCE_UNAVAILABLE", reason: "BODY_NOT_TEXT" });
    expect(r.exchanges[1]!.response.bodyEncoding).toBe("base64");
  });
});
