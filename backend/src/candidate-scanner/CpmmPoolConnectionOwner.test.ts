/**
 * Bounded CPMM pool connection owner: synthetic offline tests (assessment §8.38.17 item 15).
 *
 * Harness: an injected fake transport (dormant until start(), scriptable completions, closes and
 * listener disposal), one virtual clock and timer queue shared by the owner and a real
 * PaperRequestSession with a scripted in-memory fetch, and the real accepted collector, evidence
 * recorder, adapter, tracker and ledger on the Stage 1 fixture pool. No socket or network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import {
  CpmmPoolConnectionOwner,
  type CpmmConnectionOwnerLimits,
  type CpmmConnectionRunReport,
  type CpmmOwnerTransport,
} from "./CpmmPoolConnectionOwner.js";
import {
  CpmmPoolNotificationCollector,
  type CpmmCollectorLimits,
} from "./CpmmPoolNotificationCollector.js";
import {
  CpmmResolutionAccountingLedger,
  type CpmmNotificationEnvelope,
} from "./CpmmResolutionAccountingLedger.js";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionTimers,
} from "./PaperRequestSession.js";
import {
  CANONICAL_CPMM_AUTH_BUMP,
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateSuccess,
} from "./RaydiumCpmmPoolStateAdapter.js";
import {
  CPMM_SWAP_BASE_INPUT_DISCRIMINATOR,
  CPMM_SWAP_EVENT_DISCRIMINATOR,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./RaydiumCpmmSwapDecoder.js";
import {
  RaydiumCpmmTransactionSourceAdapter,
  createCpmmExchangeEvidenceRecorder,
  type CpmmAdapterBinding,
  type CpmmLifecycleGate,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";

type Loose = ReturnType<typeof JSON.parse>;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Literal fixtures
// ---------------------------------------------------------------------------------------------

const SECRET_KEY = "k3yS3cr3tAbCdEfGh1234";
const RPC_URL = `https://rpc.example.test/?api-key=${SECRET_KEY}`;

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const key = (n: number) => {
  const b = new Uint8Array(32);
  b[0] = 0xa0;
  b[1] = n;
  b[31] = 7;
  return new PublicKey(b).toBase58();
};
const signatureOf = (n: number) => {
  const b = new Uint8Array(64);
  b[0] = 0x5a;
  b[1] = n;
  b[63] = 3;
  return encodeBase58(b);
};
const PAYER = key(1);
const USER_WSOL = key(4);
const USER_TOKEN = key(5);
const AMM_CONFIG = key(6);
const OBSERVATION = key(7);
const CANDIDATE_A = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

function adaptedPool(): RaydiumCpmmPoolStateSuccess {
  const vault = (mint: string, raw: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58: mint,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount: raw,
      state: 1,
    });
  const r = adaptRaydiumCpmmPoolState({
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE_A },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_A,
        token1MintBase58: WSOL_MINT,
        mint0Decimals: 6,
        mint1Decimals: 9,
        status: 0,
        creatorFeeOn: 0,
        enableCreatorFee: false,
      }),
      ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault0Account: {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: vault(CANDIDATE_A, 10_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault1Account: {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: vault(WSOL_MINT, 50_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
  });
  if (!r.ok) throw new Error(`adapter refused the fixture: ${r.refusalCode}`);
  return r;
}
const POOL = adaptedPool();

interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
  children?: Ix[];
  logData?: string[];
}

function swapIx(side: "BUY" | "SELL", inAmount = 1_000_000_000n, outAmount = 2_500_000n): Ix {
  const buy = side === "BUY";
  const inVault = buy ? POOL.quoteVaultAddress : POOL.baseVaultAddress;
  const outVault = buy ? POOL.baseVaultAddress : POOL.quoteVaultAddress;
  const inMint = buy ? WSOL_MINT : POOL.candidateMint;
  const outMint = buy ? POOL.candidateMint : WSOL_MINT;
  const userIn = buy ? USER_WSOL : USER_TOKEN;
  const userOut = buy ? USER_TOKEN : USER_WSOL;
  const dec = (m: string) => (m === WSOL_MINT ? 9 : POOL.baseDecimals);
  const event = Buffer.concat([
    Buffer.from(CPMM_SWAP_EVENT_DISCRIMINATOR),
    Buffer.from(new PublicKey(POOL.poolAddress).toBytes()),
    u64(123n),
    u64(456n),
    u64(inAmount),
    u64(outAmount),
    u64(0n),
    u64(0n),
    Buffer.from([1]),
    Buffer.from(new PublicKey(inMint).toBytes()),
    Buffer.from(new PublicKey(outMint).toBytes()),
    u64(7n),
    u64(0n),
    Buffer.from([0]),
  ]);
  const tc = (amount: bigint, decimals: number) =>
    Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]);
  return {
    program: RAYDIUM_CPMM_PROGRAM_ID,
    accounts: [
      PAYER,
      RAYDIUM_CPMM_AUTHORITY,
      AMM_CONFIG,
      POOL.poolAddress,
      userIn,
      userOut,
      inVault,
      outVault,
      SPL_TOKEN_PROGRAM_ID,
      SPL_TOKEN_PROGRAM_ID,
      inMint,
      outMint,
      OBSERVATION,
    ],
    data: Buffer.concat([
      Buffer.from(CPMM_SWAP_BASE_INPUT_DISCRIMINATOR),
      u64(inAmount),
      u64(outAmount - 1n),
    ]),
    logData: [event.toString("base64")],
    children: [
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [userIn, inMint, inVault, PAYER],
        data: tc(inAmount, dec(inMint)),
      },
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [outVault, outMint, userOut, RAYDIUM_CPMM_AUTHORITY],
        data: tc(outAmount, dec(outMint)),
      },
    ],
  };
}
const TWO_SWAPS = () => [swapIx("BUY"), swapIx("SELL", 2_500_000n, 900_000_000n)];

const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const OBS_START = 1_794_829_400_000;
const RECEIVED_AT = 1_794_829_421_500;
const TRACKER_NOW = 1_794_829_422_000;

function txResult(sig: string, top: Ix[] = [swapIx("BUY")], failed = false): Loose {
  const keys: string[] = [PAYER];
  const add = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
  };
  const collect = (ix: Ix) => {
    add(ix.program);
    ix.accounts.forEach(add);
    ix.children?.forEach(collect);
  };
  top.forEach(collect);
  const compile = (ix: Ix, stackHeight: number | null) => ({
    programIdIndex: keys.indexOf(ix.program),
    accounts: ix.accounts.map((a) => keys.indexOf(a)),
    data: encodeBase58(ix.data),
    stackHeight,
  });
  const inner = top
    .map((t, index) => ({ index, instructions: (t.children ?? []).map((c) => compile(c, 2)) }))
    .filter((g) => g.instructions.length > 0);
  const logs: string[] = [];
  const log = (ix: Ix, depth: number) => {
    logs.push(`Program ${ix.program} invoke [${depth}]`);
    for (const d of ix.logData ?? []) logs.push(`Program data: ${d}`);
    for (const c of ix.children ?? []) log(c, depth + 1);
    logs.push(`Program ${ix.program} consumed 1000 of 200000 compute units`);
    logs.push(`Program ${ix.program} success`);
  };
  top.forEach((t) => log(t, 1));
  return {
    slot: SLOT,
    blockTime: BLOCK_TIME,
    version: "legacy",
    transaction: {
      signatures: [sig],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        accountKeys: keys,
        recentBlockhash: key(99),
        instructions: top.map((t) => compile(t, null)),
      },
    },
    meta: {
      err: failed ? { InstructionError: [0, { Custom: 6005 }] } : null,
      fee: 5000,
      innerInstructions: inner,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: logs,
    },
  };
}

// --- frames -----------------------------------------------------------------------------------

const SUB = 4242;
const SUB_REQ = 7;
const UNSUB_REQ = 8;
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const ackFrame = (result: unknown = SUB, id = SUB_REQ) => enc({ jsonrpc: "2.0", id, result });
const unsubAck = (result: unknown = true) => enc({ jsonrpc: "2.0", id: UNSUB_REQ, result });
const notif = (o: { sig?: string; sub?: number; err?: unknown; logs?: string[] } = {}) =>
  enc({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: o.sub ?? SUB,
      result: {
        context: { slot: SLOT },
        value: {
          signature: o.sig ?? signatureOf(1),
          err: o.err === undefined ? null : o.err,
          logs: o.logs ?? ["Program log: swap"],
        },
      },
    },
  });

// --- fetch scripting ------------------------------------------------------------------------------

type Responder = (req: { id: number; signal: AbortSignal }) => Promise<Response>;
const rpcResult =
  (result: unknown): Responder =>
  async ({ id }) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
const okTx = (n: number, top?: Ix[], failed = false) =>
  rpcResult(txResult(signatureOf(n), top, failed));
function held() {
  let id = 0;
  let resolve: ((r: Response) => void) | null = null;
  const responder: Responder = (req) =>
    new Promise<Response>((res, rej) => {
      id = req.id;
      resolve = res;
      if (req.signal.aborted) rej(new Error("aborted"));
      req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  return {
    responder,
    result: (result: unknown) =>
      resolve?.(new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 })),
  };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------------------------

type Done = (failed: boolean) => void;
interface FakeOptions {
  complete?: "microtask" | "sync" | "never" | "twice";
  failKinds?: readonly ("send" | "ping" | "pong")[];
  autoPong?: "microtask" | "none";
  closeMode?: "sync" | "async" | "never";
  terminateCloses?: boolean;
  honorDispose?: boolean;
  disposeThrows?: boolean;
  throwOn?: {
    send?: (data: string) => boolean;
    ping?: boolean;
    pong?: boolean;
    close?: boolean;
    terminate?: boolean;
    start?: boolean;
    on?: string;
  };
  /** The call emits `close` synchronously (readyState 3), then throws. */
  closeThenThrow?: readonly ("close" | "terminate" | "send" | "pong")[];
  /** Called inside a listener disposer; a throw makes the disposer throw. */
  onDispose?: (t: FakeTransport, event: string) => void;
  onRegister?: (t: FakeTransport, event: string) => void;
  onStart?: (t: FakeTransport) => void;
  onSend?: (t: FakeTransport, data: string) => void;
  onPong?: (t: FakeTransport) => void;
}

class FakeTransport implements CpmmOwnerTransport {
  public readyState = 0;
  public readonly log: string[] = [];
  public readonly sent: string[] = [];
  public readonly pinged: Uint8Array[] = [];
  public readonly ponged: Uint8Array[] = [];
  public readonly disposed: string[] = [];
  public readonly pendingDone: Done[] = [];
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();
  constructor(private readonly o: FakeOptions = {}) {}

  on(event: string, listener: (arg: never) => void): () => void {
    this.log.push(`on:${event}`);
    if (this.o.throwOn?.on === event) throw new Error(`on ${SECRET_KEY}`);
    const l = listener as unknown as (arg?: unknown) => void;
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(l);
    this.o.onRegister?.(this, event);
    const s = set;
    return () => {
      this.disposed.push(event);
      if (this.o.honorDispose !== false) s.delete(l);
      this.o.onDispose?.(this, event);
    };
  }
  private closeThenThrow(kind: "close" | "terminate" | "send" | "pong"): void {
    if (!this.o.closeThenThrow?.includes(kind)) return;
    this.readyState = 3;
    this.emit("close", 1000);
    throw new Error(`${kind} after close`);
  }
  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
  emit(event: string, arg?: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(arg);
  }
  private complete(done: Done, kind: "send" | "ping" | "pong"): void {
    if (this.o.failKinds?.includes(kind)) {
      queueMicrotask(() => done(true));
      return;
    }
    switch (this.o.complete ?? "microtask") {
      case "sync":
        done(false);
        return;
      case "never":
        this.pendingDone.push(done);
        return;
      case "twice":
        queueMicrotask(() => {
          done(false);
          done(false);
        });
        return;
      default:
        queueMicrotask(() => done(false));
    }
  }
  start(): void {
    this.log.push("start");
    if (this.o.throwOn?.start) throw new Error(`start ${SECRET_KEY}`);
    this.o.onStart?.(this);
  }
  send(data: string, done: Done): void {
    this.log.push("send");
    if (this.o.throwOn?.send?.(data)) throw new Error(`send ${SECRET_KEY}`);
    this.sent.push(data);
    this.o.onSend?.(this, data);
    this.complete(done, "send");
    this.closeThenThrow("send");
  }
  ping(payload: Uint8Array, done: Done): void {
    this.log.push("ping");
    if (this.o.throwOn?.ping) throw new Error("ping");
    const copy = payload.slice();
    this.pinged.push(copy);
    this.complete(done, "ping");
    if ((this.o.autoPong ?? "microtask") === "microtask") {
      queueMicrotask(() => this.emit("pong", copy.slice()));
    }
  }
  pong(payload: Uint8Array, done: Done): void {
    this.log.push("pong");
    if (this.o.throwOn?.pong) throw new Error("pong");
    this.ponged.push(payload.slice());
    this.complete(done, "pong");
    this.o.onPong?.(this);
    this.closeThenThrow("pong");
  }
  close(code: 1000): void {
    this.log.push(`close:${code}`);
    if (this.o.throwOn?.close) throw new Error("close");
    this.closeThenThrow("close");
    const fire = () => {
      this.readyState = 3;
      this.emit("close", 1000);
    };
    const m = this.o.closeMode ?? "sync";
    if (m === "sync") fire();
    else if (m === "async") queueMicrotask(fire);
  }
  terminate(): void {
    this.log.push("terminate");
    if (this.o.throwOn?.terminate) throw new Error("terminate");
    this.closeThenThrow("terminate");
    if (this.o.terminateCloses) this.readyState = 3;
  }
  dispose(): void {
    this.log.push("dispose");
    if (this.o.disposeThrows) throw new Error("dispose");
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  message(bytes: unknown): void {
    this.emit("message", bytes);
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const OWNER_LIMITS: CpmmConnectionOwnerLimits = {
  observationMs: 30_000,
  ackTimeoutMs: 5_000,
  unsubscribeAckTimeoutMs: 2_000,
  pingIntervalMs: 10_000,
  pongTimeoutMs: 2_000,
  maxPings: 3,
  maxPongReplies: 4,
  maxControlFrames: 16,
  maxControlPayloadBytes: 125,
  maxOutstandingResolutions: 4,
  maxRetainedUnprocessed: 4,
  drainMs: 15_000,
  cleanupTimeoutMs: 3_000,
};
const COLLECTOR_LIMITS: CpmmCollectorLimits = {
  maxFrameBytes: 4_096,
  maxEpochFrames: 64,
  maxEpochBytes: 65_536,
  maxRetainedFrameRecords: 256,
  maxRetainedNotifications: 64,
  maxEpochs: 4,
};
const NOMINAL_END = OBS_START + 30_000;
const INTAKE_END = OBS_START + 32_000;
const RUN_CEILING = OBS_START + 47_000;

interface Env {
  state: { now: number; override: number[] };
  session: PaperRequestSession;
  adapter: RaydiumCpmmTransactionSourceAdapter;
  tracker: RollingTradeFlowTracker;
  ledger: CpmmResolutionAccountingLedger;
  collector: CpmmPoolNotificationCollector;
  script: Responder[];
  fakes: FakeTransport[];
  abort: AbortController;
  owner: CpmmPoolConnectionOwner;
  factoryCalls: number;
  timers: PaperRequestSessionTimers;
  timerCount: () => number;
  readonly t: FakeTransport;
  to(t: number): Promise<void>;
  jump(t: number): Promise<void>;
}

interface EnvOptions {
  limits?: Partial<CpmmConnectionOwnerLimits>;
  collectorLimits?: Partial<CpmmCollectorLimits>;
  fake?: FakeOptions;
  factory?: (e: Env) => unknown;
  binding?: CpmmAdapterBinding;
  collectorBinding?: CpmmAdapterBinding;
  ledgerWrap?: (real: CpmmResolutionAccountingLedger, e: Env) => unknown;
  lifetimeMs?: number;
  noOpen?: boolean;
  ignoreClear?: boolean;
  /** The tracker reads the advancing virtual clock instead of a fixed instant. */
  trackerClock?: boolean;
  /** While `invalid`, only the owner's view of the session clock returns NaN. */
  ownerClock?: { invalid: boolean };
}

function env(o: EnvOptions = {}): Env {
  const state = { now: OBS_START, override: [] as number[] };
  let nextTimer = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      queue.set(id, { at: state.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (h) => {
      if (!o.ignoreClear) queue.delete(h as number);
    },
  };
  const clock = () => (state.override.length > 0 ? state.override.shift()! : state.now);
  const script: Responder[] = [];
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    const r = script.shift();
    if (!r) throw new Error("UNSCRIPTED_REQUEST");
    return r({ id: JSON.parse(String(init.body)).id, signal: init.signal as AbortSignal });
  }) as unknown as typeof fetch;
  const recorder = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 8 });
  const lane = (maxAttempts: number, pacingMs: number, maxResponseBytes: number) => ({
    maxAttempts,
    pacingMs,
    maxResponseBytes,
  });
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    limits: {
      lifetimeMs: o.lifetimeMs ?? 600_000,
      maxHttpAttempts: 40,
      requestTimeoutMs: 10_000,
      lanes: {
        SOLANA_RPC: lane(40, 2_500, 200_000),
        RUGCHECK: lane(0, 1, 1),
        SOLANA_TRACKER: lane(0, 1, 1),
        DEXSCREENER: lane(0, 1, 1),
      },
    },
    clock,
    timers,
    onExchangeComplete: (ev: PaperRequestExchangeEvidence) => recorder.observe(ev),
  });
  recorder.bind(session);
  if (!o.noOpen) session.open();
  const adapter = new RaydiumCpmmTransactionSourceAdapter({
    pool: POOL,
    session,
    evidence: recorder,
    rpcUrl: RPC_URL,
    secrets: [RPC_URL, SECRET_KEY],
    maxTrackedSignatures: 32,
    maxResponseBytes: 100_000,
  });
  const tracker = new RollingTradeFlowTracker({
    poolId: POOL.poolAddress,
    tokenMint: POOL.candidateMint,
    trackingStartedMs: OBS_START,
    clock: o.trackerClock ? () => state.now : () => TRACKER_NOW,
  });
  const ledger = new CpmmResolutionAccountingLedger({
    binding: adapter.getBinding(),
    adapter,
    tracker,
    limits: { maxSignatureRecords: 16, maxDuplicateDetailsPerRecord: 4, maxEpochs: 4 },
  });
  const collector = new CpmmPoolNotificationCollector({
    binding: o.collectorBinding ?? adapter.getBinding(),
    limits: { ...COLLECTOR_LIMITS, ...o.collectorLimits },
    commitment: "confirmed",
  });
  const fakes: FakeTransport[] = [];
  const abort = new AbortController();
  const run = async (t: number) => {
    for (;;) {
      await flush(4);
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of queue) {
        if (entry[1].at <= t && (!best || entry[1].at < best[1].at)) best = entry;
      }
      if (!best) break;
      queue.delete(best[0]);
      if (best[1].at > state.now) state.now = best[1].at;
      best[1].fn();
    }
    if (t > state.now) state.now = t;
    await flush(4);
  };
  const e: Env = {
    state,
    session,
    adapter,
    tracker,
    ledger,
    collector,
    script,
    fakes,
    abort,
    owner: null as unknown as CpmmPoolConnectionOwner,
    factoryCalls: 0,
    timers,
    timerCount: () => queue.size,
    get t() {
      return fakes[0]!;
    },
    to: run,
    /** Moves the clock first, so due timers fire late (delayed timer execution). */
    jump: async (t: number) => {
      state.now = t;
      await run(t);
    },
  };
  const oc = o.ownerClock;
  const ownerSession = oc
    ? ({
        now: () => (oc.invalid ? Number.NaN : session.now()),
        isOpen: () => session.isOpen(),
        getDeadlineMs: () => session.getDeadlineMs(),
        getStopReason: () => session.getStopReason(),
        onStop: (l: (reason: string) => void) => session.onStop(l),
      } as unknown as PaperRequestSession)
    : session;
  e.owner = new CpmmPoolConnectionOwner({
    session: ownerSession,
    collector,
    ledger: (o.ledgerWrap ? o.ledgerWrap(ledger, e) : ledger) as CpmmResolutionAccountingLedger,
    binding: o.binding ?? adapter.getBinding(),
    transportFactory: () => {
      e.factoryCalls++;
      if (o.factory) return o.factory(e) as CpmmOwnerTransport;
      const f = new FakeTransport(o.fake);
      fakes.push(f);
      return f;
    },
    timers,
    signal: abort.signal,
    epoch: 1,
    subscribeRequestId: SUB_REQ,
    unsubscribeRequestId: UNSUB_REQ,
    limits: { ...OWNER_LIMITS, ...o.limits },
  });
  return e;
}

/** Runs, opens and acknowledges at OBS_START + 10 (the run promise is wrapped, not awaited). */
async function openAndAck(e: Env): Promise<{ p: Promise<CpmmConnectionRunReport> }> {
  const p = e.owner.run();
  e.t.open();
  await e.to(OBS_START + 10);
  e.t.message(ackFrame());
  await flush();
  return { p };
}

async function note(
  e: Env,
  n: number,
  o: { at?: number; responder?: Responder | null | undefined; err?: unknown; top?: Ix[] } = {},
): Promise<void> {
  if (o.at !== undefined) await e.to(o.at);
  if (o.responder !== null) {
    e.script.push(o.responder ?? okTx(n, o.top, o.err !== undefined));
  }
  e.t.message(notif({ sig: signatureOf(n), err: o.err }));
  await flush();
}

async function finishNormally(e: Env): Promise<void> {
  await e.to(NOMINAL_END);
  e.t.message(unsubAck());
  await e.to(NOMINAL_END + 10);
}

function expectPlainFrozen(v: unknown, path = "value"): void {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
  expect(typeof v, path).toBe("object");
  expect(Object.isFrozen(v), path).toBe(true);
  for (const [k, x] of Object.entries(v as object)) expectPlainFrozen(x, `${path}.${k}`);
}

/** Item H equations at settlement. */
function expectConserved(e: Env, r: CpmmConnectionRunReport): void {
  const i = r.incoming;
  const h = r.handoff;
  const u = h.unprocessed;
  const s = h.settled;
  expect(i.messageEvents).toBe(
    i.passedToCollector + r.intake.framesAfterIntake + i.messagesBeforeStart,
  );
  if (r.ownership.collectorIntact && r.collector) {
    expect(e.collector.counters().frames).toBe(i.passedToCollector);
    expect(h.envelopesAccepted).toBe(r.collector.notificationsAccepted);
  }
  const unprocessed = u.capacity + u.intakeStopped + u.ownershipLost;
  expect(h.envelopesAccepted).toBe(unprocessed + h.accountAttempts);
  expect(h.accountAttempts).toBe(
    h.accountThrew +
      h.accountRejected +
      s.recorded +
      s.duplicate +
      s.invalid +
      s.capacityRefused +
      h.outstandingAtSettlement,
  );
  expect(u.retained.length + u.dropped).toBe(unprocessed);
  expect(r.ownership.ledgerExternalOccurrences).toBeGreaterThanOrEqual(0);
  const o = r.outgoing;
  expect(o.applicationFramesReserved).toBeLessThanOrEqual(2);
  expect(o.applicationFramesReserved).toBe(
    [o.subscribe, o.unsubscribe].filter((a) => a.local !== "NOT_ATTEMPTED").length,
  );
  for (const c of [o.pings, o.pongReplies]) {
    expect(c.reserved).toBe(c.threw + c.completed + c.failed + c.unresolved);
  }
  expect(r.events.recordsOwned).toBe(s.recorded);
  expect(Object.values(r.events.byDisposition).reduce((a, b) => a + b, 0)).toBe(
    r.events.recordsOwned,
  );
  expect(r.events.total).toBe(
    r.events.accepted + r.events.rejected + r.events.unattempted + r.events.indeterminate,
  );
  expect(i.controlFrames).toBe(i.pingsReceived + i.pongsReceived);
  expect(r.uncertainties.length).toBe(new Set(r.uncertainties).size);
  if (r.connectionRunClean) {
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.uncertainties).toEqual([]);
  }
  expectPlainFrozen(r);
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM pool connection owner (synthetic, offline)", () => {
  it("O1: construction validates every option and limit and is inert", () => {
    const e = env();
    const base = () => ({
      session: e.session,
      collector: e.collector,
      ledger: e.ledger,
      binding: e.adapter.getBinding(),
      transportFactory: () => new FakeTransport(),
      timers: e.timers,
      epoch: 1,
      subscribeRequestId: SUB_REQ,
      unsubscribeRequestId: UNSUB_REQ,
      limits: OWNER_LIMITS,
    });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ extra: 1 }, /unknown option/],
      [{ limits: { ...OWNER_LIMITS, ackTimeoutMs: 30_000 } }, /ackTimeoutMs/],
      [{ limits: { ...OWNER_LIMITS, pongTimeoutMs: 10_000 } }, /pongTimeoutMs/],
      [{ limits: { ...OWNER_LIMITS, maxPings: 2 } }, /maxPings/],
      [{ limits: { ...OWNER_LIMITS, maxControlPayloadBytes: 126 } }, /8\.\.125/],
      [{ limits: { ...OWNER_LIMITS, maxControlPayloadBytes: 7 } }, /8\.\.125/],
      [{ limits: { ...OWNER_LIMITS, drainMs: 0 } }, /drainMs/],
      [{ limits: { ...OWNER_LIMITS, cleanupTimeoutMs: 1.5 } }, /cleanupTimeoutMs/],
      [{ limits: { ...OWNER_LIMITS, extra: 1 } }, /limits/],
      [{ unsubscribeRequestId: SUB_REQ }, /differ/],
      [{ subscribeRequestId: 0 }, /request IDs/],
      [{ epoch: -1 }, /epoch/],
      [{ binding: { poolAddress: "", candidateMint: "x" } }, /binding/],
      [{ binding: { ...e.adapter.getBinding(), extra: 1 } }, /binding/],
      [{ transportFactory: 1 }, /transportFactory/],
      [{ timers: {} }, /timers/],
      [{ signal: {} }, /signal/],
      [{ session: {} }, /session/],
      [{ collector: {} }, /collector/],
      [{ ledger: e.collector }, /ledger/],
    ];
    for (const [over, re] of bad) {
      expect(
        () => new CpmmPoolConnectionOwner({ ...base(), ...over } as never),
        String(re),
      ).toThrow(re);
    }
    const { session: _s, ...missing } = base();
    void _s;
    expect(() => new CpmmPoolConnectionOwner(missing as never)).toThrow(/missing option session/);
    // Construction is inert: no factory call, no timer, no epoch, no version change.
    const timers = e.timerCount();
    const cv = e.collector.version;
    const lv = e.ledger.version;
    let calls = 0;
    new CpmmPoolConnectionOwner({
      ...base(),
      transportFactory: () => (calls++, new FakeTransport()),
    });
    expect([calls, e.factoryCalls, e.timerCount(), e.collector.version, e.ledger.version]).toEqual([
      0,
      0,
      timers,
      cv,
      lv,
    ]);
    expect(e.ledger.epochs()).toEqual([]);
    expect(e.collector.epochReport(1)).toBeNull();
  });

  it("O2/O21: start refusals open no epoch and create no transport or timer", async () => {
    const other = { poolAddress: POOL.poolAddress, candidateMint: key(42) };
    const cases: [EnvOptions, string, ((e: Env) => void)?][] = [
      [{ noOpen: true }, "SESSION_NOT_OPEN"],
      [{}, "SESSION_NOT_OPEN", (e) => e.session.stop("TEST")],
      [{ lifetimeMs: 46_999 }, "SESSION_DEADLINE_TOO_SOON"],
      [
        {
          limits: {
            observationMs: Number.MAX_SAFE_INTEGER - 1,
            pingIntervalMs: Number.MAX_SAFE_INTEGER - 1,
            maxPings: 1,
          },
        },
        "DEADLINE_ARITHMETIC",
      ],
      [
        {},
        "COLLECTOR_EPOCH_REFUSED",
        (e) =>
          void e.collector.openEpoch({
            epoch: 5,
            observationStartMs: OBS_START,
            subscribeRequestId: 99,
          }),
      ],
      [{ collectorBinding: other }, "BINDING_MISMATCH"],
      // O21: the owner and collector agree, but the ledger is bound to another mint.
      [{ collectorBinding: other, binding: other }, "BINDING_MISMATCH"],
    ];
    for (const [opts, code, prep] of cases) {
      const e = env(opts);
      prep?.(e);
      const timers = e.timerCount();
      const epochs = e.ledger.epochs().length;
      const p = e.owner.run();
      expect(e.owner.run()).toBe(p);
      const r = await p;
      expect(r.terminal, code).toMatchObject({ cause: "START_REFUSED", code });
      expect(e.factoryCalls).toBe(0);
      expect(e.timerCount()).toBe(timers);
      expect(e.ledger.epochs().length).toBe(epochs);
      expect(r.cleanup.status).toBe("NOT_NEEDED");
      expect(r.connectionRunClean).toBe(false);
      if (code !== "COLLECTOR_EPOCH_REFUSED") expect(e.collector.epochReport(1)).toBeNull();
      expectConserved(e, r);
    }
    // A ledger refusal after the collector epoch opened closes that epoch (CANCELLED).
    const l = env();
    l.ledger.openEpoch({ epoch: 3, observationStartMs: OBS_START });
    const r = await l.owner.run();
    expect(r.terminal).toMatchObject({ cause: "START_REFUSED", code: "LEDGER_EPOCH_REFUSED" });
    expect(r.collectorClose).toMatchObject({ status: "CLOSED", reason: "CANCELLED" });
    expect(l.collector.epochReport(1)!.closeReason).toBe("CANCELLED");
    expect(l.factoryCalls).toBe(0);
  });

  it("O3: a normal run is clean, byte-exact, conserved and releases its state", async () => {
    const e = env({ fake: { closeMode: "async" } });
    const p = (await openAndAck(e)).p;
    expect(e.owner.run()).toBe(p);
    await note(e, 1, { at: RECEIVED_AT });
    await e.to(RECEIVED_AT + 1_000);
    e.t.emit("ping", Uint8Array.from([1, 2, 3]));
    await note(e, 2, { at: RECEIVED_AT + 3_000 });
    await e.to(NOMINAL_END);
    expect(e.t.sent).toEqual([
      `{"jsonrpc":"2.0","id":7,"method":"logsSubscribe","params":[{"mentions":["${POOL.poolAddress}"]},{"commitment":"confirmed"}]}`,
      `{"jsonrpc":"2.0","id":8,"method":"logsUnsubscribe","params":[${SUB}]}`,
    ]);
    // Intake stop detaches message/ping/pong at once; lifecycle listeners remain for cleanup.
    e.t.message(unsubAck());
    expect(["message", "ping", "pong", "error", "close", "open"].map((x) => e.t.count(x))).toEqual([
      0, 0, 0, 1, 1, 1,
    ]);
    await e.to(NOMINAL_END + 10);
    const r = await p;
    expect(r).toMatchObject({
      terminal: { cause: "OBSERVATION_COMPLETED", code: "UNSUBSCRIBE_RESPONSE" },
      uncertainties: [],
      intake: { trigger: "UNSUBSCRIBE_RESPONSE", stoppedAtMs: NOMINAL_END, framesAfterIntake: 0 },
      outgoing: {
        subscribe: { prepared: true, local: "COMPLETED", observed: "ACKNOWLEDGED" },
        unsubscribe: { prepared: true, local: "COMPLETED", observed: "ACKNOWLEDGED" },
        applicationFramesReserved: 2,
        pings: { reserved: 2, completed: 2 },
        pongReplies: { reserved: 1, completed: 1 },
        pongsMatched: 2,
        pongsUnmatched: 0,
      },
      handoff: { envelopesAccepted: 2, accountAttempts: 2, settled: { recorded: 2 } },
      events: { recordsOwned: 2, total: 2, accepted: 2, byDisposition: { INGESTED: 2 } },
      ownership: {
        collectorIntact: true,
        ledgerEpochIntact: true,
        ledgerExternalOccurrences: 0,
        ledgerCountersConsistent: true,
      },
      collectorClose: { status: "CLOSED", reason: "OWNER_CLOSED", atMs: NOMINAL_END },
      drain: { status: "COMPLETED" },
      cleanup: {
        status: "SETTLED",
        startedAtMs: NOMINAL_END,
        deadlineMs: NOMINAL_END + 3_000,
        endedAtMs: NOMINAL_END,
      },
      deadlines: {
        startedAtMs: OBS_START,
        ackDeadlineMs: OBS_START + 5_000,
        nominalEndMs: NOMINAL_END,
        intakeEndMs: INTAKE_END,
        drainDeadlineMs: OBS_START + 47_000,
        runCeilingMs: RUN_CEILING,
        sessionDeadlineMs: OBS_START + 600_000,
      },
      connectionRunClean: true,
      notificationCompletenessEstablished: false,
      quietWindowEstablished: false,
      qualificationEligible: false,
      replayableCaptureEstablished: false,
      ledgerAccountingAssessed: false,
    });
    expect(r.settledAtMs).toBeLessThanOrEqual(RUN_CEILING);
    expect(e.t.ponged).toEqual([Uint8Array.from([1, 2, 3])]);
    expect(e.ledger.counters().occurrences).toBe(2);
    expect(e.collector.epochReport(1)).toMatchObject({ collectionClean: true });
    expectConserved(e, r);
    // Settlement disposed every handler and released the run state.
    expect(["message", "ping", "pong", "error", "close", "open"].map((x) => e.t.count(x))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(Reflect.get(e.owner, "transport")).toBeNull();
    expect(Reflect.get(Reflect.get(e.owner, "holder") as object, "run")).toBeNull();
    // The session-stop listener only counts, later.
    const before = JSON.stringify(r);
    e.session.stop("LATER");
    expect(e.owner.lateEvents().sessionStop).toBe(1);
    expect(JSON.stringify(await e.owner.run())).toBe(before);
  });

  it("O3b (clarification 4): a failed-status claim is forwarded and blocks collection, not the run cause", async () => {
    const e = env();
    const p = (await openAndAck(e)).p;
    await note(e, 3, { at: RECEIVED_AT, err: { InstructionError: [0, { Custom: 1 }] } });
    await finishNormally(e);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.handoff.accountAttempts).toBe(1);
    expect(r.events.byDisposition.POLICY_PENDING).toBe(1);
    expect(r.collector).toMatchObject({
      notificationsWithTransactionError: 1,
      collectionClean: false,
    });
    expect(r.uncertainties).toEqual([]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O4: acknowledgement rejection and a malformed acknowledgement", async () => {
    for (const [frame, code, observed] of [
      [
        enc({ jsonrpc: "2.0", id: SUB_REQ, error: { code: -32601, message: SECRET_KEY } }),
        "REJECTED",
        "REJECTED",
      ],
      [ackFrame("4242"), "MALFORMED", "MALFORMED"],
    ] as const) {
      const e = env();
      const p = e.owner.run();
      e.t.open();
      await e.to(OBS_START + 10);
      e.t.message(frame);
      const r = await p;
      expect(r.terminal).toMatchObject({
        cause: "SUBSCRIBE_REJECTED",
        code,
        phase: "AWAITING_ACK",
      });
      expect(r.outgoing.subscribe.observed).toBe(observed);
      expect(r.collectorClose).toMatchObject({ status: "CLOSED", reason: "CANCELLED" });
      expect(r.cleanup.status).toBe("SETTLED");
      expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
      expectConserved(e, r);
    }
  });

  it("O5: malformed, foreign, pre-acknowledgement, duplicate and string frames fail fast", async () => {
    const cases: [string, (e: Env) => Promise<void>][] = [
      ["PRE_ACK_NOTIFICATION", async (e) => e.t.message(notif())],
      ["DUPLICATE_RESPONSE", async (e) => e.t.message(ackFrame())],
      ["NOT_JSON", async (e) => e.t.message(enc("not json"))],
      ["FRAME_INVALID", async (e) => e.t.message(JSON.stringify({ jsonrpc: "2.0" }))],
      ["FOREIGN_SUBSCRIPTION", async (e) => e.t.message(notif({ sub: SUB + 1 }))],
    ];
    for (const [code, act] of cases) {
      const e = env();
      const p = e.owner.run();
      e.t.open();
      await e.to(OBS_START + 10);
      if (code !== "PRE_ACK_NOTIFICATION") e.t.message(ackFrame());
      const h = held();
      if (code === "FOREIGN_SUBSCRIPTION") await note(e, 1, { responder: h.responder });
      await act(e);
      await flush();
      const r = await p;
      expect(r.terminal, code).toMatchObject({ cause: "COLLECTION_DIRTY", code });
      expect(r.connectionRunClean).toBe(false);
      if (code === "FOREIGN_SUBSCRIPTION") {
        // The in-flight resolution was stopped by the gate, not ingested.
        expect(r.drain.status).toBe("ABORTED");
        expect(r.handoff.settled.recorded).toBe(1);
        expect(e.ledger.records()[0]).toMatchObject({
          disposition: "UNRESOLVED",
          blockingClass: "CANCELLED",
        });
        expect(e.tracker.getEventsCount()).toBe(0);
      }
      expectConserved(e, r);
    }
  });

  it("O6: acquisition limits, including the transport payload limit (close code 1009)", async () => {
    const big = env({ collectorLimits: { maxFrameBytes: 300 } });
    let p = (await openAndAck(big)).p;
    big.t.message(new Uint8Array(301));
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "ACQUISITION_LIMIT", code: "OVERSIZE_FRAME" });
    expect(r.collectorClose.reason).toBe("LIMIT_EXCEEDED");
    expectConserved(big, r);
    const count = env({ collectorLimits: { maxEpochFrames: 2 } });
    p = (await openAndAck(count)).p;
    await note(count, 1, { at: RECEIVED_AT });
    count.t.message(notif({ sig: signatureOf(2) }));
    await flush();
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "ACQUISITION_LIMIT", code: "EPOCH_LIMIT_EXCEEDED" });
    expectConserved(count, r);
    const payload = env();
    p = (await openAndAck(payload)).p;
    payload.t.readyState = 3;
    payload.t.emit("close", 1009);
    r = await p;
    expect(r.terminal).toMatchObject({
      cause: "ACQUISITION_LIMIT",
      code: "TRANSPORT_PAYLOAD_LIMIT",
    });
    expect(r.cleanup).toMatchObject({ status: "SETTLED", closeCode: 1009 });
    expect(payload.t.log).not.toContain("close:1000");
    expectConserved(payload, r);
  });

  it("O7: processing overflow leaves the envelope explicitly unprocessed", async () => {
    const e = env({ limits: { maxOutstandingResolutions: 1, maxRetainedUnprocessed: 1 } });
    const p = (await openAndAck(e)).p;
    const h = held();
    await note(e, 1, { at: RECEIVED_AT, responder: h.responder });
    await note(e, 2, { responder: null });
    await flush();
    const r = await p;
    expect(r.terminal).toMatchObject({ cause: "PROCESSING_OVERFLOW", code: "OUTSTANDING_LIMIT" });
    expect(r.handoff).toMatchObject({
      envelopesAccepted: 2,
      accountAttempts: 1,
      unprocessed: {
        capacity: 1,
        retained: [{ signature: signatureOf(2), reason: "CAPACITY", slot: SLOT }],
        dropped: 0,
      },
    });
    expect(r.uncertainties).toContain("UNPROCESSED_ENVELOPES");
    expect(e.ledger.counters().occurrences).toBe(1);
    expectConserved(e, r);
  });

  it("O8: disconnect in every phase, with in-flight resolutions stopped", async () => {
    const closeIn = async (phase: string, prep: (e: Env) => Promise<void>) => {
      const e = env();
      const p = e.owner.run();
      await prep(e);
      e.t.readyState = 3;
      e.t.emit("close", 1006);
      await flush();
      const r = await p;
      expect(r.terminal, phase).toMatchObject({ cause: "TRANSPORT_CLOSED", phase });
      expect(r.cleanup).toMatchObject({ status: "SETTLED", closeCode: 1006 });
      expectConserved(e, r);
      return { e, r };
    };
    await closeIn("CONNECTING", async () => {});
    await closeIn("AWAITING_ACK", async (e) => e.t.open());
    const obs = await closeIn("OBSERVING", async (e) => {
      e.t.open();
      await e.to(OBS_START + 10);
      e.t.message(ackFrame());
      await note(e, 1, { at: RECEIVED_AT, responder: held().responder });
    });
    expect(obs.r.drain.status).toBe("ABORTED");
    expect(obs.e.ledger.records()[0]!.blockingClass).toBe("CANCELLED");
    const uns = await closeIn("UNSUBSCRIBING", async (e) => {
      e.t.open();
      await e.to(OBS_START + 10);
      e.t.message(ackFrame());
      await e.to(NOMINAL_END);
    });
    expect(uns.r.outgoing.unsubscribe).toMatchObject({
      local: "COMPLETED",
      observed: "NOT_OBSERVED",
    });
    // An error event: the transport is closed by the owner.
    const err = env();
    const p = err.owner.run();
    err.t.open();
    err.t.emit("error", new Error(SECRET_KEY));
    const r = await p;
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "ERROR_EVENT" });
    expect(err.t.log).toContain("close:1000");
    expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
  });

  it("O9 (clarifications 3 and 4): keepalive, bounded control frames and payloads", async () => {
    // Pong timeout; an unmatched pong never clears the deadline.
    const t = env({ fake: { autoPong: "none" } });
    let p = (await openAndAck(t)).p;
    await t.to(OBS_START + 10_010);
    t.t.emit("pong", new Uint8Array(8).fill(9));
    await t.to(OBS_START + 12_010);
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "KEEPALIVE_TIMEOUT", code: "PONG_DEADLINE" });
    expect(r.outgoing).toMatchObject({
      pongsMatched: 0,
      pongsUnmatched: 1,
      pings: { reserved: 1 },
    });
    expectConserved(t, r);
    // The right payload exactly at the pong deadline no longer matches.
    const late = env({ fake: { autoPong: "none" } });
    p = (await openAndAck(late)).p;
    await late.to(OBS_START + 10_010);
    late.state.now = OBS_START + 12_010;
    late.t.emit("pong", late.t.pinged[0]);
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "KEEPALIVE_TIMEOUT", code: "PONG_DEADLINE" });
    expect(r.outgoing).toMatchObject({ pongsMatched: 0, pongsUnmatched: 1 });
    // Ping throwing and failing locally.
    for (const [fake, code] of [
      [{ throwOn: { ping: true } }, "PING_THREW"],
      [{ failKinds: ["ping"] }, "PING_FAILED"],
    ] as const) {
      const e = env({ fake });
      p = (await openAndAck(e)).p;
      await e.to(OBS_START + 10_010);
      r = await p;
      expect(r.terminal).toMatchObject({ cause: "KEEPALIVE_SEND_FAILED", code });
      expect(r.uncertainties).toContain("LOCAL_SEND_FAILED");
      expectConserved(e, r);
    }
    // A ping is sent only if its pong deadline fits before the nominal end.
    const fit = env({ limits: { pongTimeoutMs: 9_995 } });
    p = (await openAndAck(fit)).p;
    await finishNormally(fit);
    r = await p;
    expect(r.outgoing.pings.reserved).toBe(1);
    expect(r.connectionRunClean).toBe(true);
    // Explicit pong replies are bounded.
    const replies = env({ limits: { maxPongReplies: 1 } });
    p = (await openAndAck(replies)).p;
    replies.t.emit("ping", Uint8Array.of(1));
    replies.t.emit("ping", Uint8Array.of(2));
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "CONTROL_FRAME_LIMIT", code: "PONG_REPLY_LIMIT" });
    expect(r.outgoing.pongReplies.reserved).toBe(1);
    expectConserved(replies, r);
    // The incoming control-frame ceiling covers unsolicited and unmatched pongs.
    const flood = env({ limits: { maxControlFrames: 3 } });
    p = (await openAndAck(flood)).p;
    for (let i = 0; i < 4; i++) flood.t.emit("pong", Uint8Array.of(i));
    r = await p;
    expect(r.terminal).toMatchObject({
      cause: "CONTROL_FRAME_LIMIT",
      code: "INCOMING_CONTROL_FRAMES",
    });
    expect(r.incoming).toMatchObject({ pongsReceived: 4, controlFrames: 4 });
    expect(r.outgoing.pongsUnmatched).toBe(3);
    expectConserved(flood, r);
    // Payloads are bounded and validated as genuine views before any copy or comparison.
    const genuine200 = new Uint8Array(200);
    Object.defineProperty(genuine200, "byteLength", { value: 1 });
    let traps = 0;
    const proxy = new Proxy(new Uint8Array(8), {
      get(target, k) {
        traps++;
        return k === "byteLength" ? 1 : (Reflect.get(target, k) as unknown);
      },
      getPrototypeOf(target) {
        traps++;
        return Reflect.getPrototypeOf(target);
      },
    });
    for (const [payload, cause, code] of [
      [new Uint8Array(17), "CONTROL_FRAME_LIMIT", "CONTROL_PAYLOAD_OVERSIZE"],
      [genuine200, "CONTROL_FRAME_LIMIT", "CONTROL_PAYLOAD_OVERSIZE"],
      [proxy, "TRANSPORT_ERROR", "CONTROL_PAYLOAD_INVALID"],
      ["\u0001", "TRANSPORT_ERROR", "CONTROL_PAYLOAD_INVALID"],
    ] as const) {
      const e = env({ limits: { maxControlPayloadBytes: 16 } });
      p = (await openAndAck(e)).p;
      e.t.emit("ping", payload);
      r = await p;
      expect(r.terminal, code).toMatchObject({ cause, code });
      expect(e.t.ponged).toEqual([]);
      expectConserved(e, r);
    }
    expect(traps).toBe(0);
  });

  it("O10: cancellation at every stage keeps the first cause", async () => {
    const before = env();
    before.abort.abort();
    let r = await before.owner.run();
    expect(r.terminal).toMatchObject({ cause: "CANCELLED", code: "ABORTED_BEFORE_START" });
    expect(before.factoryCalls).toBe(0);
    // Inside the factory: the returned transport is disposed and never started.
    for (const disposeThrows of [false, true]) {
      const f = env({
        factory: (e) => {
          const fake = new FakeTransport({ disposeThrows });
          e.fakes.push(fake);
          e.abort.abort();
          return fake;
        },
      });
      r = await f.owner.run();
      expect(r.terminal).toMatchObject({ cause: "CANCELLED", phase: "CONNECTING" });
      expect(f.t.log).toEqual(["dispose"]);
      // Clarification 5: a throwing disposal is never reported as disposed.
      expect(r.cleanup.status).toBe(disposeThrows ? "DISPOSE_FAILED" : "DISPOSED_UNSTARTED");
      expect(r.uncertainties.includes("CLEANUP_FAILED")).toBe(disposeThrows);
      expectConserved(f, r);
    }
    const at = async (phase: string, prep: (e: Env) => Promise<void>) => {
      const e = env();
      const p = e.owner.run();
      await prep(e);
      e.abort.abort();
      await flush();
      const res = await p;
      expect(res.terminal, phase).toMatchObject({ cause: "CANCELLED", phase });
      expect(res.cancellation.phase).toBe(phase);
      expectConserved(e, res);
      return { e, r: res };
    };
    const connecting = await at("CONNECTING", async () => {});
    expect(connecting.e.t.log).toContain("close:1000");
    await at("AWAITING_ACK", async (e) => e.t.open());
    const observing = await at("OBSERVING", async (e) => {
      e.t.open();
      await e.to(OBS_START + 10);
      e.t.message(ackFrame());
      await note(e, 1, { at: RECEIVED_AT, responder: held().responder });
    });
    expect(observing.e.ledger.records()[0]).toMatchObject({
      blockingClass: "CANCELLED",
      factKind: "CANCELLED_IN_FLIGHT",
    });
    await at("UNSUBSCRIBING", async (e) => {
      e.t.open();
      await e.to(OBS_START + 10);
      e.t.message(ackFrame());
      await e.to(NOMINAL_END);
    });
    // While draining after a normal stop: the cause stays, the drain is aborted.
    const d = env();
    let p = (await openAndAck(d)).p;
    await note(d, 1, { at: RECEIVED_AT, responder: held().responder });
    await finishNormally(d);
    d.abort.abort();
    await flush();
    r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.drain.status).toBe("ABORTED");
    expect(r.cancellation.phase).toBe("DRAINING");
    expect(r.uncertainties).toContain("CANCELLED_AFTER_TERMINAL");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(d, r);
    // During cleanup: terminate() at once; the cause is preserved.
    const c = env({ fake: { closeMode: "never", terminateCloses: true } });
    p = c.owner.run();
    c.t.open();
    c.t.emit("error");
    await flush();
    c.abort.abort();
    r = await p;
    expect(r.terminal.cause).toBe("TRANSPORT_ERROR");
    expect(r.cleanup).toMatchObject({
      status: "SETTLED_AFTER_TERMINATE",
      terminateAttempted: true,
    });
    expect(r.uncertainties).toContain("CANCELLED_AFTER_TERMINAL");
  });

  it("O11: a session stop in every phase", async () => {
    const a = env();
    let p = a.owner.run();
    a.t.open();
    a.session.stop("TEST");
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "SESSION_STOPPED", phase: "AWAITING_ACK" });
    expect(r.sessionStopObserved).toBe(true);
    const b = env();
    p = (await openAndAck(b)).p;
    await note(b, 1, { at: RECEIVED_AT, responder: held().responder });
    b.session.stop("TEST");
    await flush();
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "SESSION_STOPPED", phase: "OBSERVING" });
    expect(["SESSION_ENDED", "CANCELLED"]).toContain(b.ledger.records()[0]!.blockingClass);
    expectConserved(b, r);
    const c = env();
    p = (await openAndAck(c)).p;
    await note(c, 1, { at: RECEIVED_AT, responder: held().responder });
    await finishNormally(c);
    c.session.stop("TEST");
    await flush();
    r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.uncertainties).toContain("SESSION_STOPPED_AFTER_TERMINAL");
    expect(r.drain.status).toBe("ABORTED");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(c, r);
  });

  it("O12: foreign epoch changes during resolution, with frames", async () => {
    // Ledger: a foreign openEpoch while a resolution is in flight.
    const l = env();
    let p = (await openAndAck(l)).p;
    const h = held();
    await note(l, 1, { at: RECEIVED_AT, responder: h.responder });
    l.ledger.openEpoch({ epoch: 2, observationStartMs: RECEIVED_AT });
    await note(l, 2, { at: RECEIVED_AT + 3_000, responder: null });
    h.result(txResult(signatureOf(1)));
    await flush();
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "EPOCH_OWNERSHIP_LOST", code: "WITNESS" });
    expect(r.ownership.ledgerEpochIntact).toBe(false);
    expect(r.handoff.unprocessed.ownershipLost).toBe(1);
    expect(["EPOCH_CLOSED", "CANCELLED"]).toContain(l.ledger.records()[0]!.blockingClass);
    expect(l.tracker.getEventsCount()).toBe(0);
    expectConserved(l, r);
    // Collector: a foreign openEpoch, then a frame (stale for our epoch).
    const c = env();
    p = (await openAndAck(c)).p;
    c.collector.openEpoch({ epoch: 2, observationStartMs: RECEIVED_AT, subscribeRequestId: 99 });
    await note(c, 1, { at: RECEIVED_AT, responder: null });
    r = await p;
    expect(r.terminal.cause).toBe("EPOCH_OWNERSHIP_LOST");
    expect(r.ownership.collectorIntact).toBe(false);
    expect(r.collectorClose.status).toBe("ALREADY_CLOSED");
    expectConserved(c, r);
  });

  it("O13: send, close and terminate exceptions and local completion failures", async () => {
    for (const [fake, code, local] of [
      [{ throwOn: { send: () => true } }, "THREW", "THREW"],
      [{ failKinds: ["send"] }, "LOCAL_FAILURE", "FAILED"],
    ] as const) {
      const e = env({ fake });
      const p = e.owner.run();
      e.t.open();
      await flush();
      const r = await p;
      expect(r.terminal).toMatchObject({ cause: "SUBSCRIBE_SEND_FAILED", code });
      expect(r.outgoing.subscribe.local).toBe(local);
      expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
      expectConserved(e, r);
    }
    // A second local completion is counted and makes a normal run unclean.
    const twice = env({ fake: { complete: "twice" } });
    let p = (await openAndAck(twice)).p;
    await finishNormally(twice);
    let r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.outgoing.duplicateCompletions).toBeGreaterThan(0);
    expect(r.connectionRunClean).toBe(false);
    // The unsubscribe send throwing.
    const uns = env({ fake: { throwOn: { send: (d) => d.includes("logsUnsubscribe") } } });
    p = (await openAndAck(uns)).p;
    await uns.to(NOMINAL_END);
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "UNSUBSCRIBE_SEND_THREW" });
    expect(r.outgoing.unsubscribe).toMatchObject({ prepared: true, local: "THREW" });
    expectConserved(uns, r);
    // close() throwing, then terminate() closing; terminate() throwing and staying open.
    const ct = env({ fake: { throwOn: { close: true }, terminateCloses: true } });
    p = ct.owner.run();
    ct.t.open();
    ct.t.emit("error");
    await ct.to(OBS_START + 3_000);
    r = await p;
    expect(r.cleanup).toMatchObject({
      status: "SETTLED_AFTER_TERMINATE",
      closeThrew: true,
      terminateAttempted: true,
    });
    const tt = env({ fake: { closeMode: "never", throwOn: { terminate: true } } });
    p = tt.owner.run();
    tt.t.open();
    tt.t.emit("error");
    await tt.to(OBS_START + 3_000);
    r = await p;
    expect(r.cleanup).toMatchObject({ status: "FAILED_STILL_OPEN", terminateThrew: true });
    expect(r.uncertainties).toContain("CLEANUP_FAILED");
  });

  it("O14: callbacks after settlement change only the late-event counters", async () => {
    let release: ((v: unknown) => void) | null = null;
    const e = env({
      fake: { honorDispose: false, complete: "never" },
      ignoreClear: true,
      ledgerWrap: (real) => ({
        openEpoch: (x: never) => real.openEpoch(x),
        epochs: () => real.epochs(),
        counters: () => real.counters(),
        getBinding: () => real.getBinding(),
        account: (x: CpmmNotificationEnvelope, g: CpmmLifecycleGate) => {
          void real.account(x, g);
          return new Promise((res) => {
            release = res;
          });
        },
      }),
    });
    const p = e.owner.run();
    e.t.open();
    await e.to(OBS_START + 10);
    e.t.message(ackFrame());
    await note(e, 1, { at: RECEIVED_AT, responder: held().responder });
    e.t.emit("error");
    await e.to(RECEIVED_AT + 3_000);
    const r = await p;
    expect(r.handoff.outstandingAtSettlement).toBe(1);
    expect(r.outgoing.subscribe.local).toBe("UNRESOLVED");
    const snapshot = JSON.stringify(r);
    for (const ev of ["message", "open", "error", "close", "ping", "pong"]) e.t.emit(ev, notif());
    const pendingDone = e.t.pendingDone.length;
    expect(pendingDone).toBe(3); // the subscribe and two pings never completed
    e.t.pendingDone.forEach((d) => d(false));
    release!({ status: "DUPLICATE" });
    e.abort.abort();
    e.session.stop("LATER");
    await e.to(RUN_CEILING + 60_000);
    expect(e.owner.lateEvents()).toMatchObject({
      message: 1,
      open: 1,
      error: 1,
      close: 1,
      ping: 1,
      pong: 1,
      localCompletion: pendingDone,
      accountSettlement: 1,
      abort: 0,
      sessionStop: 1,
    });
    expect(e.owner.lateEvents().timer).toBeGreaterThan(0);
    expect(JSON.stringify(await e.owner.run())).toBe(snapshot);
  });

  it("O15 (clarification 5): cleanup failure keeps the cause and reports inspectable times", async () => {
    const e = env({ fake: { closeMode: "never" } });
    const p = (await openAndAck(e)).p;
    await finishNormally(e);
    await e.to(NOMINAL_END + 3_000);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.cleanup).toMatchObject({
      status: "FAILED_STILL_OPEN",
      startedAtMs: NOMINAL_END,
      deadlineMs: NOMINAL_END + 3_000,
      endedAtMs: NOMINAL_END + 3_000,
      terminateAttempted: true,
    });
    expect(r.settledAtMs).toBe(NOMINAL_END + 3_000);
    expect(r.uncertainties).toEqual(["CLEANUP_FAILED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O16: dormant start, events before start(), start() throwing and registration failure", async () => {
    // An event during registration (before start) is a contract violation.
    const pre = env({
      fake: { onRegister: (t, ev) => ev === "pong" && t.emit("message", notif()) },
    });
    let r = await pre.owner.run();
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "EVENT_BEFORE_START" });
    expect(r.transport).toMatchObject({ started: false, eventsBeforeStart: 1 });
    expect(r.incoming.messagesBeforeStart).toBe(1);
    expect(pre.t.log).toContain("dispose");
    expect(pre.t.log).not.toContain("start");
    expect(r.cleanup.status).toBe("DISPOSED_UNSTARTED");
    expectConserved(pre, r);
    // start() throwing: the transport counts as started and is closed.
    const st = env({ fake: { throwOn: { start: true } } });
    r = await st.owner.run();
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "START_FAILED" });
    expect(st.t.log).toContain("close:1000");
    // A synchronous open inside start().
    const so = env({ fake: { onStart: (t) => t.open() } });
    const p = so.owner.run();
    expect(so.t.sent.length).toBe(1);
    await so.to(OBS_START + 10);
    so.t.message(ackFrame());
    await finishNormally(so);
    expect((await p).connectionRunClean).toBe(true);
    // Registration throwing: the disposers obtained are called and the transport disposed.
    const reg = env({ fake: { throwOn: { on: "pong" } } });
    r = await reg.owner.run();
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "HANDLER_REGISTRATION" });
    expect(reg.t.disposed).toEqual(["message", "ping", "error", "close"]);
    expect(reg.t.log.at(-1)).toBe("dispose");
    expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
  });

  it("O17: intake boundaries are applied by the clock, before the frame", async () => {
    // A frame exactly at the acknowledgement deadline is not passed (no timer has run).
    const a = env();
    let p = a.owner.run();
    a.t.open();
    a.state.now = OBS_START + 5_000;
    a.t.message(ackFrame());
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "ACK_TIMEOUT" });
    expect(r.intake.framesAfterIntake).toBe(1);
    expect(r.incoming.passedToCollector).toBe(0);
    expectConserved(a, r);
    // Tail frames are still handed off.
    const t = env();
    p = (await openAndAck(t)).p;
    await t.to(NOMINAL_END);
    await note(t, 5, { at: NOMINAL_END + 500 });
    t.t.message(unsubAck());
    await t.to(NOMINAL_END + 600);
    r = await p;
    expect(r.handoff.accountAttempts).toBe(1);
    expect(r.connectionRunClean).toBe(true);
    // A frame exactly at the hard intake end stops intake first.
    const i = env();
    p = (await openAndAck(i)).p;
    await i.to(NOMINAL_END);
    i.state.now = INTAKE_END;
    i.t.message(notif());
    r = await p;
    expect(r.intake).toMatchObject({ trigger: "INTAKE_DEADLINE", framesAfterIntake: 1 });
    expect(r.uncertainties).toEqual(
      expect.arrayContaining(["FRAMES_AFTER_INTAKE", "UNSUBSCRIBE_NOT_ACKNOWLEDGED"]),
    );
    expect(r.connectionRunClean).toBe(false);
    expectConserved(i, r);
  });

  it("O18: conservation over a mixed sequence", async () => {
    const e = env();
    const p = (await openAndAck(e)).p;
    await note(e, 1, { at: RECEIVED_AT });
    await note(e, 1, { at: RECEIVED_AT + 100, responder: null });
    e.t.emit("ping", Uint8Array.of(7));
    e.t.emit("pong", Uint8Array.of(1));
    await note(e, 2, { at: RECEIVED_AT + 2_600, err: "x" });
    await e.to(NOMINAL_END);
    await note(e, 4, { at: NOMINAL_END + 100 });
    e.t.message(unsubAck());
    await e.to(NOMINAL_END + 200);
    const r = await p;
    expect(r.handoff).toMatchObject({
      envelopesAccepted: 4,
      accountAttempts: 4,
      settled: { recorded: 3, duplicate: 1 },
    });
    expect(r.outgoing.pongsUnmatched).toBe(1);
    expect(r.connectionRunClean).toBe(false);
    expect(e.ledger.counters().occurrences).toBe(4);
    expectConserved(e, r);
  });

  it("O19: credential-bearing failures and frames leave no trace", async () => {
    const e = env({ fake: { throwOn: { send: () => true } } });
    const p = e.owner.run();
    e.t.open();
    e.t.emit("error", new Error(RPC_URL));
    e.t.emit("close", RPC_URL);
    const r = await p;
    const text = JSON.stringify([r, e.owner.lateEvents()]);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("rpc.example.test");
    const f = env();
    const q = (await openAndAck(f)).p;
    f.t.message(enc({ jsonrpc: "2.0", method: "x", params: { url: RPC_URL } }));
    const r2 = await q;
    expect(JSON.stringify(r2)).not.toContain(SECRET_KEY);
  });

  it("O20: source boundaries and exact imports", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./CpmmPoolConnectionOwner.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /(?<!\.)\b(setTimeout|setInterval|setImmediate)\s*\(|queueMicrotask/,
      /Date\.now|performance\.now|new Date\(/,
      /WebSocket|from "ws"/,
      /process\.env/,
      /node:fs|readFile|writeFile|mkdir/,
      /\.dispatch\(|\.summarize\(|session\.(open|stop)\(/,
      /\badapter\.|ingestTrade|tracker|enumerat|\bseal/i,
      /\.records\(\)/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    const imports = [...src.matchAll(/^import([^;]*)from "([^"]+)";/gm)];
    expect(imports.map((m) => m[2])).toEqual([
      "./CpmmResolutionAccountingLedger.js",
      "./CpmmPoolNotificationCollector.js",
      "./PaperRequestSession.js",
      "./RaydiumCpmmTransactionSourceAdapter.js",
    ]);
    for (const m of imports) expect(m[1]!.trim().startsWith("type ")).toBe(true);
  });

  it("O22: foreign epoch changes without frames are detected by the witnesses", async () => {
    const cases: [string, (e: Env) => void, keyof CpmmConnectionRunReport["ownership"]][] = [
      [
        "collector openEpoch",
        (e) =>
          void e.collector.openEpoch({
            epoch: 2,
            observationStartMs: OBS_START + 100,
            subscribeRequestId: 99,
          }),
        "collectorIntact",
      ],
      [
        "ledger openEpoch (valid)",
        (e) => void e.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START + 100 }),
        "ledgerEpochIntact",
      ],
      [
        "ledger openEpoch (refused)",
        (e) => void e.ledger.openEpoch({ epoch: 0, observationStartMs: OBS_START + 100 }),
        "ledgerEpochIntact",
      ],
      [
        "ledger account",
        (e) => void e.ledger.account({ notification: {}, epoch: 1, hostReceivedAtMs: 1 }),
        "ledgerExternalOccurrences",
      ],
    ];
    for (const [name, foreign, field] of cases) {
      const e = env();
      const p = (await openAndAck(e)).p;
      await e.to(OBS_START + 100);
      foreign(e);
      const events = e.collector.counters().frames;
      await e.to(OBS_START + 10_010);
      const r = await p;
      expect(r.terminal, name).toMatchObject({
        cause: "EPOCH_OWNERSHIP_LOST",
        code: "WITNESS",
        phase: "OBSERVING",
      });
      expect(e.collector.counters().frames).toBe(events);
      if (field === "ledgerExternalOccurrences") {
        expect(r.ownership).toMatchObject({
          ledgerExternalOccurrences: 1,
          ledgerEpochIntact: true,
        });
      } else expect(r.ownership[field], name).toBe(false);
      expect(r.connectionRunClean).toBe(false);
      expectConserved(e, r);
    }
  });

  it("O22b (clarification 6): an external occurrence after a normal stop is never clean", async () => {
    const e = env();
    const p = (await openAndAck(e)).p;
    await note(e, 1, { at: RECEIVED_AT, responder: held().responder });
    await finishNormally(e);
    void e.ledger.account({ notification: {}, epoch: 1, hostReceivedAtMs: 1 });
    // No frame: the next authoritative check is the owner's next wake-up (the cleanup deadline).
    await e.to(NOMINAL_END + 3_000);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.ownership).toMatchObject({
      ledgerExternalOccurrences: 1,
      ledgerEpochIntact: true,
      ledgerCountersConsistent: true,
    });
    expect(r.uncertainties).toContain("EPOCH_OWNERSHIP_LOST");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O23: delayed timers never extend acknowledgement waiting or intake", async () => {
    const e = env();
    let p = (await openAndAck(e)).p;
    await e.jump(INTAKE_END + 500);
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", code: "INTAKE_DEADLINE" });
    expect(r.outgoing.unsubscribe.local).toBe("NOT_ATTEMPTED");
    expect(r.outgoing.pings.reserved).toBe(0);
    expect(r.uncertainties).toContain("DEADLINE_OVERRUN");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
    const a = env();
    p = a.owner.run();
    a.t.open();
    await a.jump(OBS_START + 6_000);
    r = await p;
    expect(r.terminal).toMatchObject({ cause: "ACK_TIMEOUT", atMs: OBS_START + 6_000 });
  });

  it("O24: a factory that advances the clock past the acknowledgement deadline", async () => {
    const e = env({
      factory: (x) => {
        x.state.now = OBS_START + 5_000;
        const f = new FakeTransport();
        x.fakes.push(f);
        return f;
      },
    });
    const r = await e.owner.run();
    expect(r.terminal).toMatchObject({ cause: "ACK_TIMEOUT", phase: "CONNECTING" });
    expect(e.t.log).toEqual(["dispose"]);
    expect(r.cleanup.status).toBe("DISPOSED_UNSTARTED");
  });

  it("O25 (clarifications 1 and 2): synchronous re-entrancy cannot exceed any reservation", async () => {
    // Re-entrant run() from the factory, start() and send(): one execution, one subscribe.
    let fromFactory: unknown = null;
    let fromSend: unknown = null;
    const e = env({
      factory: (x) => {
        fromFactory = x.owner.run();
        const f = new FakeTransport({
          complete: "sync",
          onStart: (t) => t.open(),
          onSend: (t) => {
            fromSend = x.owner.run();
            t.emit("open");
          },
        });
        x.fakes.push(f);
        return f;
      },
    });
    const p = e.owner.run();
    expect([fromFactory, fromSend]).toEqual([p, p]);
    expect(e.factoryCalls).toBe(1);
    await e.to(OBS_START + 10);
    e.t.message(ackFrame());
    await finishNormally(e);
    let r = await p;
    expect(e.t.sent.length).toBe(2);
    expect(r.connectionRunClean).toBe(true);
    // A pong reply that re-enters with another ping: the reply limit holds.
    const c = env({
      limits: { maxPongReplies: 2 },
      fake: { onPong: (t) => t.emit("ping", Uint8Array.of(1)) },
    });
    let q = (await openAndAck(c)).p;
    c.t.emit("ping", Uint8Array.of(1));
    r = await q;
    expect(r.terminal).toMatchObject({ cause: "CONTROL_FRAME_LIMIT", code: "PONG_REPLY_LIMIT" });
    expect(r.outgoing.pongReplies.reserved).toBe(2);
    expect(c.t.ponged.length).toBe(2);
    // A ledger call that re-enters with another notification: the slot was reserved first.
    let nested = false;
    const l = env({
      limits: { maxOutstandingResolutions: 1 },
      ledgerWrap: (real, x) => ({
        openEpoch: (v: never) => real.openEpoch(v),
        epochs: () => real.epochs(),
        counters: () => real.counters(),
        getBinding: () => real.getBinding(),
        account: (v: CpmmNotificationEnvelope, g: CpmmLifecycleGate) => {
          if (!nested) {
            nested = true;
            x.t.message(notif({ sig: signatureOf(2) }));
          }
          return real.account(v, g);
        },
      }),
    });
    q = (await openAndAck(l)).p;
    await note(l, 1, { at: RECEIVED_AT, responder: held().responder });
    await flush();
    r = await q;
    expect(r.terminal).toMatchObject({ cause: "PROCESSING_OVERFLOW" });
    expect(r.handoff).toMatchObject({ accountAttempts: 1, unprocessed: { capacity: 1 } });
    expectConserved(l, r);
  });

  it("O26: unresolved local completions make a normal run unclean", async () => {
    const e = env({ fake: { complete: "never" } });
    const p = (await openAndAck(e)).p;
    await finishNormally(e);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.outgoing).toMatchObject({
      subscribe: { local: "UNRESOLVED", observed: "ACKNOWLEDGED" },
      unsubscribe: { local: "UNRESOLVED", observed: "ACKNOWLEDGED" },
      pings: { reserved: 2, unresolved: 2 },
    });
    expect(r.uncertainties).toContain("LOCAL_COMPLETION_UNRESOLVED");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O27: a clock regression at the collector closure is never masked by a normal cause", async () => {
    const e = env();
    const p = (await openAndAck(e)).p;
    await e.to(NOMINAL_END);
    e.state.override.push(NOMINAL_END, NOMINAL_END - 1);
    e.t.message(unsubAck());
    await e.to(NOMINAL_END + 10);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    // The closure uses the monotonic instant (never before the latest receipt), so the collector
    // accepts it; the regression itself is latched as blocking uncertainty.
    expect(r.collectorClose).toMatchObject({
      status: "CLOSED",
      reason: "OWNER_CLOSED",
      atMs: NOMINAL_END,
    });
    expect(r.intake.stoppedAtMs).toBe(NOMINAL_END);
    expect(r.uncertainties).toEqual(["CLOCK_REGRESSED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O28: exact owned ingestion counts, with duplicates never recounted", async () => {
    // Pre-ingest the first of two swap events, so that ingestion is partial.
    const pre = env();
    pre.script.push(okTx(2, TWO_SWAPS()));
    const fact = await pre.adapter.resolve({
      signature: signatureOf(2),
      slot: SLOT,
      receivedAtMs: RECEIVED_AT,
    });
    const e = env();
    expect(e.tracker.ingestTrade(fact.events[0]!).ok).toBe(true);
    const p = (await openAndAck(e)).p;
    await note(e, 1, { at: RECEIVED_AT });
    await note(e, 2, { at: RECEIVED_AT + 2_600, top: TWO_SWAPS() });
    await note(e, 1, { at: RECEIVED_AT + 2_700, responder: null });
    await note(e, 3, { at: RECEIVED_AT + 5_200, err: "x" });
    await note(e, 4, { at: RECEIVED_AT + 7_800, responder: rpcResult(null) });
    await e.to(RECEIVED_AT + 8_000);
    await finishNormally(e);
    const r = await p;
    expect(r.events).toEqual({
      recordsOwned: 4,
      byDisposition: {
        PENDING: 0,
        INGESTED: 1,
        INGESTION_INCOMPLETE: 1,
        POLICY_PENDING: 1,
        UNRESOLVED: 1,
      },
      total: 3,
      accepted: 2,
      rejected: 1,
      unattempted: 0,
      indeterminate: 0,
    });
    expect(r.handoff.settled).toEqual({
      recorded: 4,
      duplicate: 1,
      invalid: 0,
      capacityRefused: 0,
    });
    // Independently: the ledger's own records sum to the same owned counts.
    const recs = e.ledger.records();
    const sum = (k: "total" | "accepted" | "rejected") =>
      recs.reduce((s, x) => s + x.ingestion[k], 0);
    expect([sum("total"), sum("accepted"), sum("rejected")]).toEqual([3, 2, 1]);
    expect(recs.reduce((s, x) => s + x.duplicateOccurrences, 0)).toBe(1);
    expectConserved(e, r);
  });

  it("O29 (clarification 7): an expired drain is truthful and blocking under a normal cause", async () => {
    const e = env({ limits: { drainMs: 1_000 } });
    const { p } = await openAndAck(e);
    // Dispatched late enough that the session's request timeout cannot end it first.
    await note(e, 1, { at: NOMINAL_END - 500, responder: held().responder });
    await finishNormally(e);
    await e.to(INTAKE_END + 1_000);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.drain).toEqual({ status: "EXPIRED", outstandingAtDeadline: 1 });
    expect(r.handoff.outstandingAtSettlement).toBe(1);
    expect(r.uncertainties).toEqual(["DRAIN_EXPIRED"]);
    expect(r.settledAtMs).toBe(INTAKE_END + 1_000);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
    await flush();
    expect(e.owner.lateEvents().accountSettlement).toBe(1);
  });

  it("O30: a throwing or rejecting ledger call is counted, never silently dropped", async () => {
    const wrap =
      (mode: "THROW_BEFORE" | "THROW_AFTER" | "REJECT" | "REJECT_UNRECORDED") =>
      (real: CpmmResolutionAccountingLedger) => ({
        openEpoch: (v: never) => real.openEpoch(v),
        epochs: () => real.epochs(),
        counters: () => real.counters(),
        getBinding: () => real.getBinding(),
        account: (v: CpmmNotificationEnvelope, g: CpmmLifecycleGate) => {
          if (mode === "THROW_BEFORE") throw new Error(SECRET_KEY);
          if (mode === "THROW_AFTER") {
            void real.account(v, g);
            throw new Error(SECRET_KEY);
          }
          // REJECT records the occurrence first; REJECT_UNRECORDED never reaches the ledger.
          if (mode === "REJECT") void real.account(v, g);
          return Promise.reject(new Error(SECRET_KEY));
        },
      });
    for (const mode of ["THROW_BEFORE", "THROW_AFTER", "REJECT", "REJECT_UNRECORDED"] as const) {
      const e = env({ ledgerWrap: wrap(mode) });
      const { p } = await openAndAck(e);
      await note(e, 1, {
        at: RECEIVED_AT,
        responder: mode === "THROW_AFTER" || mode === "REJECT" ? undefined : null,
      });
      await finishNormally(e);
      await e.to(NOMINAL_END + 3_000);
      const r = await p;
      expect(r.terminal.cause, mode).toBe("OBSERVATION_COMPLETED");
      expect(r.handoff).toMatchObject({
        envelopesAccepted: 1,
        accountAttempts: 1,
        accountThrew: mode.startsWith("THROW") ? 1 : 0,
        accountRejected: mode.startsWith("REJECT") ? 1 : 0,
        outstandingAtSettlement: 0,
      });
      // A promise that settles without any recorded occurrence is an unexpected counter delta.
      const consistent = mode !== "REJECT_UNRECORDED";
      expect(r.ownership).toMatchObject({
        ledgerCountersConsistent: consistent,
        ledgerExternalOccurrences: 0,
      });
      expect(r.uncertainties).toEqual(
        consistent
          ? ["ACCOUNT_CALL_FAILED"]
          : ["LEDGER_COUNTER_INCONSISTENT", "ACCOUNT_CALL_FAILED"],
      );
      expect(r.connectionRunClean).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
      expectConserved(e, r);
    }
  });

  it("O31: an unacknowledged or rejected unsubscribe is never clean, even with nothing else wrong", async () => {
    const silent = env();
    let { p } = await openAndAck(silent);
    await silent.to(INTAKE_END);
    let r = await p;
    expect(r.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", code: "INTAKE_DEADLINE" });
    expect(r.outgoing.unsubscribe).toMatchObject({ local: "COMPLETED", observed: "NOT_OBSERVED" });
    expect(r.uncertainties).toEqual(["UNSUBSCRIBE_NOT_ACKNOWLEDGED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(silent, r);
    const rejected = env();
    ({ p } = await openAndAck(rejected));
    await rejected.to(NOMINAL_END);
    rejected.t.message(unsubAck(false));
    await rejected.to(NOMINAL_END + 10);
    r = await p;
    expect(r.intake.trigger).toBe("UNSUBSCRIBE_RESPONSE");
    expect(r.outgoing.unsubscribe.observed).toBe("REJECTED");
    expect(r.collector!.collectionClean).toBe(true);
    expect(r.uncertainties).toEqual(["UNSUBSCRIBE_NOT_ACKNOWLEDGED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(rejected, r);
  });

  // --- review regressions: deadlines, clock regression and the settlement barrier -------------

  /** The settled report, or null if the run has not settled by then (no hang). */
  const settledNow = (p: Promise<CpmmConnectionRunReport>) =>
    Promise.race([p, flush(8).then(() => null)]);
  const DRAIN_DEADLINE = INTAKE_END + OWNER_LIMITS.drainMs;
  const CLEANUP_DEADLINE = NOMINAL_END + OWNER_LIMITS.cleanupTimeoutMs;

  it("O32: a resolution completing at or after the drain deadline is never credited, even with delayed timers", async () => {
    expect(DRAIN_DEADLINE).toBe(RUN_CEILING);
    for (const offset of [-1, 0, 1]) {
      const e = env({ trackerClock: true });
      const { p } = await openAndAck(e);
      const h = held();
      await note(e, 1, { at: NOMINAL_END - 500, responder: h.responder });
      await finishNormally(e);
      expect(e.timerCount()).toBeGreaterThan(0);
      e.state.now = DRAIN_DEADLINE + offset; // no queued timer runs
      h.result(txResult(signatureOf(1)));
      const r = await settledNow(p);
      expect(r, String(offset)).not.toBeNull();
      expect(r!.deadlines).toMatchObject({
        drainDeadlineMs: DRAIN_DEADLINE,
        runCeilingMs: RUN_CEILING,
      });
      expect(r!.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", atMs: NOMINAL_END });
      expect(r!.settledAtMs).toBe(DRAIN_DEADLINE + offset);
      if (offset < 0) {
        expect(r!.drain.status).toBe("COMPLETED");
        expect(r!.events.accepted).toBe(1);
        expect(r!.connectionRunClean).toBe(true);
      } else {
        expect(r!.drain).toEqual({ status: "EXPIRED", outstandingAtDeadline: 1 });
        expect(r!.handoff.outstandingAtSettlement).toBe(1);
        expect(r!.events.recordsOwned).toBe(0);
        expect(r!.uncertainties).toEqual(
          offset === 0 ? ["DRAIN_EXPIRED"] : ["DRAIN_EXPIRED", "DEADLINE_OVERRUN"],
        );
        expect(r!.connectionRunClean).toBe(false);
        // The gate refused ingestion at the authoritative clock: nothing reached the tracker.
        expect(e.ledger.records()[0]!.ingestion.accepted).toBe(0);
        expect(e.owner.lateEvents().accountSettlement).toBe(1);
      }
      expectConserved(e, r!);
    }
  });

  it("O33: a close observed at or after the cleanup deadline never settles cleanup", async () => {
    for (const at of [
      CLEANUP_DEADLINE - 1,
      CLEANUP_DEADLINE,
      CLEANUP_DEADLINE + 1,
      RUN_CEILING + 5,
    ]) {
      const e = env({ fake: { closeMode: "never" } });
      const { p } = await openAndAck(e);
      await e.to(NOMINAL_END);
      e.t.message(unsubAck());
      await flush();
      expect(e.timerCount()).toBeGreaterThan(0);
      e.state.now = at; // the cleanup-deadline wake-up has not run
      e.t.readyState = 3;
      e.t.emit("close", 1000);
      const r = await settledNow(p);
      expect(r, String(at)).not.toBeNull();
      expect(r!.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", atMs: NOMINAL_END });
      expect(r!.cleanup).toMatchObject({
        startedAtMs: NOMINAL_END,
        deadlineMs: CLEANUP_DEADLINE,
        endedAtMs: at,
        closeObservedAtMs: at,
      });
      expect(r!.settledAtMs).toBe(at);
      if (at < CLEANUP_DEADLINE) {
        expect(r!.cleanup).toMatchObject({ status: "SETTLED", terminateAttempted: false });
        expect(r!.connectionRunClean).toBe(true);
      } else {
        expect(r!.cleanup).toMatchObject({
          status: "SETTLED_AFTER_TERMINATE",
          terminateAttempted: true,
        });
        expect(r!.uncertainties).toEqual(at > RUN_CEILING ? ["DEADLINE_OVERRUN"] : []);
        expect(r!.connectionRunClean).toBe(false);
      }
      expectConserved(e, r!);
    }
  });

  it("O34: the clock is re-read after an external call returns", async () => {
    // No local completion ever arrives, so nothing but the owner's own re-check can stop intake.
    const e: Env = env({
      fake: {
        complete: "never",
        onSend: (_t, d) => {
          if (d.includes("logsUnsubscribe")) e.state.now = INTAKE_END + 7;
        },
      },
    });
    const { p } = await openAndAck(e);
    await e.to(NOMINAL_END);
    const r = await settledNow(p);
    expect(r).not.toBeNull();
    expect(r!.outgoing.unsubscribe.reservedAtMs).toBe(NOMINAL_END);
    expect(r!.terminal).toMatchObject({
      cause: "OBSERVATION_COMPLETED",
      code: "INTAKE_DEADLINE",
      atMs: INTAKE_END + 7,
    });
    expect(r!.intake).toMatchObject({ trigger: "INTAKE_DEADLINE", stoppedAtMs: INTAKE_END + 7 });
    expect(r!.cleanup.startedAtMs).toBe(INTAKE_END + 7);
    expect(r!.settledAtMs).toBe(INTAKE_END + 7);
    expect(r!.uncertainties).toContain("UNSUBSCRIBE_NOT_ACKNOWLEDGED");
    expect(r!.connectionRunClean).toBe(false);
    expectConserved(e, r!);
  });

  it("O35a: a clock regression after a normal intake closure is latched and never reversed", async () => {
    const e = env({ fake: { closeMode: "never" } });
    const { p } = await openAndAck(e);
    await finishAtNominalEnd(e);
    e.state.now = NOMINAL_END - 1;
    e.t.readyState = 3;
    e.t.emit("close", 1000);
    const r = await settledNow(p);
    expect(r).not.toBeNull();
    expect(r!.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", atMs: NOMINAL_END });
    // Reported instants never run backwards: the latest authoritative reading is kept.
    expect(r!.cleanup).toMatchObject({
      status: "SETTLED",
      startedAtMs: NOMINAL_END,
      endedAtMs: NOMINAL_END,
      closeObservedAtMs: NOMINAL_END,
    });
    expect(r!.settledAtMs).toBe(NOMINAL_END);
    expect(r!.deadlines).toMatchObject({
      nominalEndMs: NOMINAL_END,
      intakeEndMs: INTAKE_END,
      runCeilingMs: RUN_CEILING,
    });
    expect(r!.uncertainties).toEqual(["CLOCK_REGRESSED"]);
    expect(r!.connectionRunClean).toBe(false);
    expectConserved(e, r!);
  });

  it("O35b: invalid time after a normal terminal cause is latched as blocking", async () => {
    const e = env({ fake: { closeMode: "never" } });
    const { p } = await openAndAck(e);
    await finishAtNominalEnd(e);
    e.state.override.push(Number.NaN);
    e.t.readyState = 3;
    e.t.emit("close", 1000);
    const r = await settledNow(p);
    expect(r).not.toBeNull();
    expect(r!.terminal).toMatchObject({ cause: "OBSERVATION_COMPLETED", atMs: NOMINAL_END });
    expect(r!.cleanup).toMatchObject({ endedAtMs: NOMINAL_END, closeObservedAtMs: NOMINAL_END });
    expect(r!.uncertainties).toEqual(["CLOCK_INVALID"]);
    expect(r!.connectionRunClean).toBe(false);
    expectConserved(e, r!);
  });

  it("O35c: a regression during observation is the first cause and the frame is refused", async () => {
    const e = env();
    const { p } = await openAndAck(e);
    await e.to(RECEIVED_AT);
    e.t.emit("ping", new Uint8Array(8)); // the owner reads RECEIVED_AT
    await flush();
    e.state.now = RECEIVED_AT - 1;
    e.t.message(notif());
    const r = await settledNow(p);
    expect(r).not.toBeNull();
    expect(r!.terminal).toMatchObject({
      cause: "OWNER_INTERNAL_ERROR",
      code: "CLOCK_REGRESSED",
      atMs: RECEIVED_AT,
    });
    expect(r!.intake.framesAfterIntake).toBe(1);
    expect(r!.handoff.envelopesAccepted).toBe(0);
    expect(r!.uncertainties).toContain("CLOCK_REGRESSED");
    expectConserved(e, r!);
  });

  it("O35d: during the drain, a regressed or invalid clock refuses ingestion through the gate", async () => {
    for (const mode of ["CLOCK_REGRESSED", "CLOCK_INVALID"] as const) {
      const ownerClock = { invalid: false };
      const e = env({ trackerClock: true, ownerClock });
      const { p } = await openAndAck(e);
      const h = held();
      await note(e, 1, { at: NOMINAL_END - 500, responder: h.responder });
      await finishNormally(e);
      // The owner's latest reading was the intake stop at NOMINAL_END.
      if (mode === "CLOCK_REGRESSED") e.state.now = NOMINAL_END - 1;
      else ownerClock.invalid = true; // the session, adapter and tracker keep a valid clock
      h.result(txResult(signatureOf(1)));
      const r = await settledNow(p);
      expect(r, mode).not.toBeNull();
      expect(r!.terminal.cause).toBe("OBSERVATION_COMPLETED");
      expect(r!.events.accepted).toBe(0);
      expect(e.ledger.records()[0]!.ingestion.accepted).toBe(0);
      expect(r!.uncertainties).toContain(mode);
      expect(r!.connectionRunClean).toBe(false);
      expectConserved(e, r!);
    }
  });

  it("O37: a rejected resolution at or after the drain deadline is never credited", async () => {
    let reject: ((e: Error) => void) | null = null;
    const e = env({
      ledgerWrap: (real) => ({
        openEpoch: (x: never) => real.openEpoch(x),
        epochs: () => real.epochs(),
        counters: () => real.counters(),
        getBinding: () => real.getBinding(),
        account: (x: CpmmNotificationEnvelope, g: CpmmLifecycleGate) => {
          void real.account(x, g);
          return new Promise((_res, rej) => {
            reject = rej;
          });
        },
      }),
    });
    const { p } = await openAndAck(e);
    await note(e, 1, { at: NOMINAL_END - 500 });
    await finishNormally(e);
    e.state.now = DRAIN_DEADLINE; // the drain wake-up has not run
    reject!(new Error(SECRET_KEY));
    const r = await settledNow(p);
    expect(r).not.toBeNull();
    expect(r!.drain).toEqual({ status: "EXPIRED", outstandingAtDeadline: 1 });
    expect(r!.handoff).toMatchObject({ accountRejected: 0, outstandingAtSettlement: 1 });
    expect(r!.settledAtMs).toBe(DRAIN_DEADLINE);
    expect(r!.uncertainties).toEqual(["DRAIN_EXPIRED"]);
    expect(e.owner.lateEvents().accountSettlement).toBe(1);
    expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
    expectConserved(e, r!);
  });

  it("O36a: close() emitting close and then throwing is recorded before settlement", async () => {
    const e = env({ fake: { closeThenThrow: ["close"] } });
    const { p } = await openAndAck(e);
    await finishNormally(e);
    const r = await p;
    expect(r.cleanup).toMatchObject({ status: "SETTLED", closeThrew: true });
    expect(r.uncertainties).toEqual(["CLEANUP_FAILED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O36b: terminate() emitting close and then throwing is recorded before settlement", async () => {
    const e = env({ fake: { closeMode: "never", closeThenThrow: ["terminate"] } });
    const { p } = await openAndAck(e);
    await finishNormally(e);
    await e.to(CLEANUP_DEADLINE);
    const r = await p;
    expect(r.cleanup).toMatchObject({
      status: "SETTLED_AFTER_TERMINATE",
      terminateAttempted: true,
      terminateThrew: true,
    });
    expect(r.uncertainties).toEqual(["CLEANUP_FAILED"]);
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O36c: a send that completes and closes synchronously, then throws, is recorded", async () => {
    const e = env({ fake: { complete: "sync", closeThenThrow: ["send"] } });
    const p = e.owner.run();
    e.t.open();
    const r = await p;
    expect(r.terminal.cause).toBe("TRANSPORT_CLOSED");
    expect(r.outgoing.subscribe.local).toBe("COMPLETED");
    expect(r.uncertainties).toContain("LOCAL_SEND_FAILED");
    expectConserved(e, r);
  });

  it("O36d: a pong reply that closes synchronously, then throws, is recorded", async () => {
    const e = env({ fake: { closeThenThrow: ["pong"] } });
    const { p } = await openAndAck(e);
    e.t.emit("ping", new Uint8Array(8));
    const r = await p;
    expect(r.outgoing.pongReplies).toMatchObject({ reserved: 1, threw: 1, unresolved: 0 });
    expect(r.uncertainties).toContain("LOCAL_SEND_FAILED");
    expectConserved(e, r);
  });

  it("O36e: an intake disposer that closes synchronously, then throws, is recorded", async () => {
    const e = env({
      fake: {
        onDispose: (x, ev) => {
          if (ev !== "message") return;
          x.readyState = 3;
          x.emit("close", 1000);
          throw new Error("dispose");
        },
      },
    });
    const { p } = await openAndAck(e);
    await finishNormally(e);
    const r = await p;
    expect(r.transport.disposeFailures).toBe(1);
    expect(r.uncertainties).toContain("DISPOSE_FAILED");
    expect(r.connectionRunClean).toBe(false);
    expectConserved(e, r);
  });

  it("O36f: the settlement instant is read after disposal bookkeeping", async () => {
    const e: Env = env({
      fake: {
        onDispose: (_x, ev) => {
          if (ev === "open") e.state.now += 5;
        },
      },
    });
    const { p } = await openAndAck(e);
    await finishAtNominalEnd(e);
    const r = await p;
    expect(r.cleanup.endedAtMs).toBe(NOMINAL_END);
    expect(r.settledAtMs).toBe(NOMINAL_END + 5);
    expect(r.connectionRunClean).toBe(true);
  });
});

/** A normal finish that leaves the clock at the nominal end (where settlement happens). */
async function finishAtNominalEnd(e: Env): Promise<void> {
  await e.to(NOMINAL_END);
  e.t.message(unsubAck());
  await flush();
}
