/**
 * CPMM pool observation recorder: synthetic offline tests (assessment §8.38.17 item 17 B).
 *
 * Unit tests run the decorator over the real accepted wrapper with an injected fake `ws`-like
 * client. Integration regressions run the real accepted owner, wrapper, collector, ledger,
 * adapter, evidence recorder and shared session over a virtual clock, injected timers, a scripted
 * in-memory fetch and the fake client. No socket, request, file or clock is used.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type CpmmFrameRecord,
} from "./CpmmPoolNotificationCollector.js";
import {
  CPMM_EXCHANGE_ENDPOINT_LABEL,
  CPMM_OBSERVATION_RECORDER_LIMIT_KEYS,
  createCpmmPoolObservationRecorder,
  createExchangeObserverFanOut,
  type CpmmObservationFinishInput,
  type CpmmObservationRecorderLimits,
  type CpmmObservationSnapshot,
  type CpmmPoolObservationRecorder,
  type CpmmRecordedAccountCall,
  type CpmmRecordedAccountSettlement,
  type CpmmRecordedCall,
  type CpmmRecordedCompletion,
  type CpmmRecordedEvent,
} from "./CpmmPoolObservationRecorder.js";
import {
  CpmmPoolWebSocketTransport,
  type CpmmPoolWebSocketTransportLimits,
  type CpmmWsClientConstructor,
  type CpmmWsClientEvent,
  type CpmmWsClientLike,
  type CpmmWsClientOptions,
} from "./CpmmPoolWebSocketTransport.js";
import { CpmmResolutionAccountingLedger } from "./CpmmResolutionAccountingLedger.js";
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
  CPMM_TX_PURPOSE,
  RaydiumCpmmTransactionSourceAdapter,
  createCpmmExchangeEvidenceRecorder,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const SECRET = "k3yS3cr3tRecAbCd1234";
const HOST = "rpc.example.test";
const ENDPOINT = `wss://${HOST}/ws?api-key=${SECRET}`;
const RPC_URL = `https://${HOST}/?api-key=${SECRET}`;
const FRAME_BYTES = 4_096;
const WS_LIMITS: CpmmPoolWebSocketTransportLimits = {
  maxFrameBytes: FRAME_BYTES,
  maxFragments: 8,
  maxBufferedChunks: 64,
  handshakeTimeoutMs: 4_999,
  closeTimeoutMs: 3_000,
};
const RLIMITS: CpmmObservationRecorderLimits = {
  maxIncomingRecords: 64,
  maxIncomingPayloadBytes: 65_536,
  maxOutgoingRecords: 64,
  maxOutgoingPayloadBytes: 65_536,
  maxControlRecords: 64,
  maxControlPayloadBytes: 8_192,
  maxLifecycleRecords: 128,
  maxExchangeRecords: 16,
  maxExchangeBodyBytes: 1_000_000,
  maxLedgerCallRecords: 64,
  maxInstrumentationFailures: 16,
  maxPayloadBytesPerRecord: 200_000,
  maxFinishCopyNodes: 200_000,
};
const EMPTY_INPUT: CpmmObservationFinishInput = {
  report: null,
  owner: null,
  wrapper: null,
  collector: null,
  ledger: null,
  session: null,
  sessionLedgerStart: 0,
  epoch: 1,
  fanOut: null,
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string | null) => Buffer.from(s ?? "", "base64");
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

function credError(): Error {
  return new Error(`failed for ${ENDPOINT} key=${SECRET}`);
}

function expectDeepFrozen(v: unknown, path = "snapshot"): void {
  if (v === null || typeof v !== "object") return;
  expect(Object.isFrozen(v), path).toBe(true);
  for (const [k, x] of Object.entries(v as object)) expectDeepFrozen(x, `${path}.${k}`);
}

function expectNoSecret(v: unknown): void {
  const s = JSON.stringify(v);
  expect(s.includes(SECRET)).toBe(false);
  expect(s.includes(HOST)).toBe(false);
}

const events = (s: CpmmObservationSnapshot, list: "incoming" | "control" | "lifecycle") =>
  (s[list] as readonly { kind: string }[]).filter(
    (r): r is CpmmRecordedEvent => r.kind === "EVENT",
  );
const calls = (s: CpmmObservationSnapshot, list: "outgoing" | "control" | "lifecycle") =>
  (s[list] as readonly { kind: string }[]).filter((r): r is CpmmRecordedCall => r.kind === "CALL");
const completions = (s: CpmmObservationSnapshot, list: "outgoing" | "control") =>
  (s[list] as readonly { kind: string }[]).filter(
    (r): r is CpmmRecordedCompletion => r.kind === "COMPLETION",
  );

// ---------------------------------------------------------------------------------------------
// Fake `ws`-like client (EventEmitter semantics: an error with no listener throws)
// ---------------------------------------------------------------------------------------------

type Cb = (err?: unknown) => void;
interface Script {
  complete?: "sync" | "microtask" | "never" | "twice" | "fail";
  autoPong?: boolean;
  closeMode?: "sync" | "none";
  throwOn?: Partial<Record<"send" | "ping" | "pong" | "close" | "terminate", boolean>>;
}

class FakeClient implements CpmmWsClientLike {
  public readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  public readonly calls: { name: string; args: unknown[] }[] = [];
  public readonly pending: Cb[] = [];
  #rs = 0;
  #binaryType = "nodebuffer";
  constructor(
    public readonly address: string,
    public readonly options: CpmmWsClientOptions,
    public readonly s: Script,
  ) {}
  get readyState(): number {
    return this.#rs;
  }
  get binaryType(): string {
    return this.#binaryType;
  }
  set binaryType(v: string) {
    this.#binaryType = v;
  }
  on(event: CpmmWsClientEvent, listener: (...a: unknown[]) => void): this {
    const ls = this.listeners.get(event) ?? [];
    ls.push(listener);
    this.listeners.set(event, ls);
    return this;
  }
  removeListener(): this {
    return this;
  }
  removeAllListeners(): this {
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    const ls = this.listeners.get(event) ?? [];
    if (event === "error" && ls.length === 0) throw args[0];
    for (const l of [...ls]) l(...args);
  }
  #complete(cb: Cb): void {
    switch (this.s.complete ?? "microtask") {
      case "sync":
        cb();
        return;
      case "never":
        this.pending.push(cb);
        return;
      case "twice":
        queueMicrotask(() => {
          cb();
          cb();
        });
        return;
      case "fail":
        queueMicrotask(() => cb(credError()));
        return;
      default:
        queueMicrotask(() => cb());
    }
  }
  send(data: string, cb: Cb): void {
    this.calls.push({ name: "send", args: [data] });
    if (this.s.throwOn?.send) throw credError();
    this.#complete(cb);
  }
  ping(data: Uint8Array, mask: boolean, cb: Cb): void {
    this.calls.push({ name: "ping", args: [Buffer.from(data), mask] });
    if (this.s.throwOn?.ping) throw credError();
    this.#complete(cb);
    if (this.s.autoPong) {
      const echo = Buffer.from(data);
      queueMicrotask(() => this.emit("pong", echo));
    }
  }
  pong(data: Uint8Array, mask: boolean, cb: Cb): void {
    this.calls.push({ name: "pong", args: [Buffer.from(data), mask] });
    if (this.s.throwOn?.pong) throw credError();
    this.#complete(cb);
  }
  close(...args: unknown[]): void {
    this.calls.push({ name: "close", args });
    if (this.s.throwOn?.close) throw credError();
    if ((this.s.closeMode ?? "sync") === "sync") this.finishClose(1000);
  }
  terminate(): void {
    this.calls.push({ name: "terminate", args: [] });
    if (this.s.throwOn?.terminate) throw credError();
    this.#rs = 2;
  }
  open(): void {
    this.#rs = 1;
    this.emit("open");
  }
  finishClose(code: unknown): void {
    this.#rs = 3;
    this.emit("close", code, Buffer.from(`bye ${SECRET}`));
  }
  message(data: unknown, isBinary = false): void {
    this.emit("message", data, isBinary);
  }
}

function fakeCtor(s: Script = {}) {
  const instances: FakeClient[] = [];
  const ctor = class extends FakeClient {
    constructor(address: string, options: CpmmWsClientOptions) {
      super(address, options, s);
      instances.push(this);
    }
  };
  return { ctor: ctor as unknown as CpmmWsClientConstructor, instances };
}

/** The real wrapper, decorated. */
function wrapped(s: Script = {}, limits: Partial<CpmmObservationRecorderLimits> = {}) {
  const f = fakeCtor(s);
  const w = new CpmmPoolWebSocketTransport({
    endpoint: ENDPOINT,
    clientConstructor: f.ctor,
    limits: WS_LIMITS,
  });
  const r = createCpmmPoolObservationRecorder({ limits: { ...RLIMITS, ...limits } });
  const t = r.recordTransport(w);
  return {
    f,
    w,
    r,
    t,
    get c(): FakeClient {
      return f.instances[0]!;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pool, transactions and frames (the Stage 1 fixture pool)
// ---------------------------------------------------------------------------------------------

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
const CANDIDATE = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

function adaptedPool(): RaydiumCpmmPoolStateSuccess {
  const vault = (mint: string, raw: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58: mint,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount: raw,
      state: 1,
    });
  const r = adaptRaydiumCpmmPoolState({
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE,
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
      data: vault(CANDIDATE, 10_000_000_000n),
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
  if (!r.ok) throw new Error(`fixture refused: ${r.refusalCode}`);
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

function swapBuy(inAmount = 1_000_000_000n, outAmount = 2_500_000n): Ix {
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
    Buffer.from(new PublicKey(WSOL_MINT).toBytes()),
    Buffer.from(new PublicKey(POOL.candidateMint).toBytes()),
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
      USER_WSOL,
      USER_TOKEN,
      POOL.quoteVaultAddress,
      POOL.baseVaultAddress,
      SPL_TOKEN_PROGRAM_ID,
      SPL_TOKEN_PROGRAM_ID,
      WSOL_MINT,
      POOL.candidateMint,
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
        accounts: [USER_WSOL, WSOL_MINT, POOL.quoteVaultAddress, PAYER],
        data: tc(inAmount, 9),
      },
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [POOL.baseVaultAddress, POOL.candidateMint, USER_TOKEN, RAYDIUM_CPMM_AUTHORITY],
        data: tc(outAmount, POOL.baseDecimals),
      },
    ],
  };
}

const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const OBS_START = 1_794_829_400_000;
const RECEIVED_AT = 1_794_829_421_500;
const TRACKER_NOW = 1_794_829_422_000;
const NOMINAL_END = OBS_START + 30_000;

function txResult(sig: string): unknown {
  const top = [swapBuy()];
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
      err: null,
      fee: 5000,
      innerInstructions: top.map((t, index) => ({
        index,
        instructions: (t.children ?? []).map((c) => compile(c, 2)),
      })),
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: logs,
    },
  };
}

const SUB = 4242;
const SUB_REQ = 7;
const UNSUB_REQ = 8;
const enc = (v: unknown) => Buffer.from(JSON.stringify(v));
const ackFrame = () => enc({ jsonrpc: "2.0", id: SUB_REQ, result: SUB });
const unsubAck = () => enc({ jsonrpc: "2.0", id: UNSUB_REQ, result: true });
const notif = (n: number) =>
  enc({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: SUB,
      result: {
        context: { slot: SLOT },
        value: { signature: signatureOf(n), err: null, logs: ["Program log: swap"] },
      },
    },
  });

type Responder = (req: { id: number }) => Promise<Response>;
const okTx =
  (n: number): Responder =>
  async ({ id }) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result: txResult(signatureOf(n)) }), {
      status: 200,
    });

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
  maxFrameBytes: FRAME_BYTES,
  maxEpochFrames: 64,
  maxEpochBytes: 65_536,
  maxRetainedFrameRecords: 256,
  maxRetainedNotifications: 64,
  maxEpochs: 4,
};

// ---------------------------------------------------------------------------------------------
// Integration harness: real owner, wrapper, collector, ledger, adapter and session
// ---------------------------------------------------------------------------------------------

interface EnvOptions {
  /** false: the same composition without the recorder (the R1 baseline). */
  record?: boolean;
  client?: Script;
  limits?: Partial<CpmmObservationRecorderLimits>;
  collectorLimits?: Partial<CpmmCollectorLimits>;
  extraObservers?: { label: string; observe: (e: PaperRequestExchangeEvidence) => void }[];
}

function env(o: EnvOptions = {}) {
  const state = { now: OBS_START };
  let nextTimer = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      queue.set(id, { at: state.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (h) => {
      queue.delete(h as number);
    },
  };
  const script: Responder[] = [];
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    const r = script.shift();
    if (!r) throw new Error("UNSCRIPTED_REQUEST");
    return r({ id: JSON.parse(String(init.body)).id });
  }) as unknown as typeof fetch;
  const evidence = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 8 });
  const order: string[] = [];
  const recorder =
    o.record === false
      ? null
      : createCpmmPoolObservationRecorder({ limits: { ...RLIMITS, ...o.limits } });
  const observers: { label: string; observe: (e: PaperRequestExchangeEvidence) => void }[] = [
    {
      label: "adapter-evidence",
      observe: (ev) => {
        order.push("adapter");
        evidence.observe(ev);
      },
    },
  ];
  if (recorder !== null) {
    const r = recorder;
    observers.push({
      label: "observation-recorder",
      observe: (ev) => {
        order.push("recorder");
        r.observeExchange(ev);
      },
    });
  }
  observers.push(...(o.extraObservers ?? []));
  const fanOut = createExchangeObserverFanOut({ observers, maxRetainedFailures: 8 });
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    limits: {
      lifetimeMs: 600_000,
      maxHttpAttempts: 40,
      requestTimeoutMs: 10_000,
      lanes: {
        SOLANA_RPC: { maxAttempts: 40, pacingMs: 2_500, maxResponseBytes: 200_000 },
        RUGCHECK: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
        SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
        DEXSCREENER: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
      },
    },
    clock: () => state.now,
    timers,
    onExchangeComplete: fanOut.observe,
  });
  evidence.bind(session);
  session.open();
  const sessionLedgerStart = session.getLedgerLength();
  const adapter = new RaydiumCpmmTransactionSourceAdapter({
    pool: POOL,
    session,
    evidence,
    rpcUrl: RPC_URL,
    secrets: [RPC_URL, SECRET],
    maxTrackedSignatures: 32,
    maxResponseBytes: 100_000,
  });
  const ledger = new CpmmResolutionAccountingLedger({
    binding: adapter.getBinding(),
    adapter,
    tracker: new RollingTradeFlowTracker({
      poolId: POOL.poolAddress,
      tokenMint: POOL.candidateMint,
      trackingStartedMs: OBS_START,
      clock: () => TRACKER_NOW,
    }),
    limits: { maxSignatureRecords: 16, maxDuplicateDetailsPerRecord: 4, maxEpochs: 4 },
  });
  const collector = new CpmmPoolNotificationCollector({
    binding: adapter.getBinding(),
    limits: { ...COLLECTOR_LIMITS, ...o.collectorLimits },
    commitment: "confirmed",
  });
  const f = fakeCtor(o.client ?? {});
  const wrappers: CpmmPoolWebSocketTransport[] = [];
  const owner = new CpmmPoolConnectionOwner({
    session,
    collector,
    ledger: recorder !== null ? recorder.recordLedger(ledger) : ledger,
    binding: adapter.getBinding(),
    transportFactory: (): CpmmOwnerTransport => {
      const w = new CpmmPoolWebSocketTransport({
        endpoint: ENDPOINT,
        clientConstructor: f.ctor,
        limits: WS_LIMITS,
      });
      wrappers.push(w);
      return recorder !== null ? recorder.recordTransport(w) : w;
    },
    timers,
    epoch: 1,
    subscribeRequestId: SUB_REQ,
    unsubscribeRequestId: UNSUB_REQ,
    limits: OWNER_LIMITS,
  });
  const to = async (t: number) => {
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
  const input = (report: CpmmConnectionRunReport | null): CpmmObservationFinishInput => ({
    report,
    owner,
    wrapper: wrappers[0] ?? null,
    collector,
    ledger,
    session,
    sessionLedgerStart,
    epoch: 1,
    fanOut,
  });
  return {
    state,
    session,
    sessionLedgerStart,
    ledger,
    collector,
    owner,
    fanOut,
    recorder: recorder as CpmmPoolObservationRecorder,
    script,
    order,
    to,
    input,
    f,
    get c(): FakeClient {
      return f.instances[0]!;
    },
    get w(): CpmmPoolWebSocketTransport {
      return wrappers[0]!;
    },
  };
}
type Env = ReturnType<typeof env>;

/** The run promise is wrapped, not awaited. */
async function startAndAck(e: Env): Promise<{ p: Promise<CpmmConnectionRunReport> }> {
  const p = e.owner.run();
  e.c.open();
  await e.to(OBS_START + 10);
  e.c.message(ackFrame());
  await flush();
  return { p };
}

async function finishNormally(e: Env): Promise<void> {
  await e.to(NOMINAL_END);
  e.c.message(unsubAck());
  await e.to(NOMINAL_END + 10);
}

/** One resolved notification, a duplicate, an incoming ping, and a normal end. */
async function scenario(e: Env): Promise<CpmmConnectionRunReport> {
  const { p } = await startAndAck(e);
  await e.to(RECEIVED_AT);
  e.script.push(okTx(1));
  e.c.message(notif(1));
  await flush();
  await e.to(RECEIVED_AT + 3_000);
  e.c.message(notif(1)); // duplicate: no request
  e.c.emit("ping", Buffer.from([9, 9]));
  await flush();
  await finishNormally(e);
  return p;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM pool observation recorder (synthetic, offline)", () => {
  it("R0: options and limits are validated exactly; construction records nothing", () => {
    expect(() => createCpmmPoolObservationRecorder({ limits: RLIMITS })).not.toThrow();
    const bad: unknown[] = [
      null,
      { limits: RLIMITS, extra: 1 },
      { limits: { ...RLIMITS, extra: 1 } },
      { limits: { ...RLIMITS, maxIncomingRecords: -1 } },
      { limits: { ...RLIMITS, maxIncomingRecords: 1.5 } },
      { limits: { ...RLIMITS, maxPayloadBytesPerRecord: 0 } },
      { limits: { ...RLIMITS, maxFinishCopyNodes: 0 } },
      { limits: new Proxy({ ...RLIMITS }, {}) },
      {
        limits: Object.defineProperty({ ...RLIMITS }, "maxExchangeRecords", {
          get: () => 1,
          enumerable: true,
        }),
      },
    ];
    for (const options of bad) {
      expect(
        () =>
          createCpmmPoolObservationRecorder(options as { limits: CpmmObservationRecorderLimits }),
        JSON.stringify(options),
      ).toThrow(/^\[CPMM_RECORDER_INIT\]/);
    }
    for (const k of CPMM_OBSERVATION_RECORDER_LIMIT_KEYS) {
      const limits: Record<string, number> = { ...RLIMITS };
      delete limits[k];
      expect(() =>
        createCpmmPoolObservationRecorder({
          limits: limits as unknown as CpmmObservationRecorderLimits,
        }),
      ).toThrow(/^\[CPMM_RECORDER_INIT\]/);
    }
    // Zero allowances are valid: nothing is retained, everything is counted.
    const zero = Object.fromEntries(
      CPMM_OBSERVATION_RECORDER_LIMIT_KEYS.map((k) => [k, 0]),
    ) as unknown as CpmmObservationRecorderLimits;
    const r = createCpmmPoolObservationRecorder({
      limits: { ...zero, maxPayloadBytesPerRecord: 1, maxFinishCopyNodes: 1 },
    });
    const s = r.finish(EMPTY_INPUT);
    expect(s.ordinalsAssigned).toBe(0);
    expect(s.instrumentation).toEqual({
      complete: true,
      failures: 0,
      retainedFailures: [],
      droppedFailureRecords: 0,
    });
    expect(s.material).toBe("UNSANITIZED_MEMORY_ONLY");
  });

  it("R1a: the decorator is transparent: synchronous and re-entrant calls, completions, fixed exceptions and the genuine readyState", () => {
    const m = wrapped({ complete: "sync", closeMode: "none" });
    const log: string[] = [];
    m.t.on("open", () => log.push("open"));
    // Before start: the wrapper's fixed exception, rethrown as the identical object.
    const notStarted = thrown(() => m.t.send("x", () => undefined));
    expect((notStarted as Error).message).toBe("[CPMM_WS] NOT_STARTED");
    m.t.start();
    m.c.open();
    expect(log).toEqual(["open"]);
    // A synchronous completion inside the call, re-entering send from the done callback.
    m.t.send("first", (failed) => {
      log.push(`done1:${failed}`);
      m.t.send("nested", (f2) => log.push(`done2:${f2}`));
      log.push("after-nested");
    });
    log.push("returned");
    expect(log).toEqual(["open", "done1:false", "done2:false", "after-nested", "returned"]);
    // Invalid arguments reach the wrapper unchanged (a non-function done is not wrapped).
    const invalid = thrown(() =>
      (m.t.send as (d: unknown, cb: unknown) => void)("x", "not-a-function"),
    );
    expect((invalid as Error).message).toBe("[CPMM_WS] INVALID_ARGUMENT");
    m.t.terminate();
    expect(m.t.readyState).toBe(2);
    expect(m.w.readyState).toBe(2);
    const s = m.r.finish(EMPTY_INPUT);
    const sends = calls(s, "outgoing");
    expect(sends.map((c) => [c.outcome, c.exceptionCode, c.completionObserved])).toEqual([
      ["THREW", "NOT_STARTED", true],
      ["RETURNED", null, true],
      ["RETURNED", null, true],
      ["THREW", "INVALID_ARGUMENT", false],
    ]);
    const [, first, nested] = sends;
    const done = completions(s, "outgoing");
    // Ordinals show the nesting: first < done1 < nested < done2 < nested.end < first.end.
    expect(done.map((d) => [d.callOrdinal, d.invocation, d.afterCallEnded])).toEqual([
      [first!.ordinal, 1, false],
      [nested!.ordinal, 1, false],
    ]);
    expect(first!.ordinal).toBeLessThan(done[0]!.ordinal);
    expect(done[0]!.ordinal).toBeLessThan(nested!.ordinal);
    expect(nested!.endOrdinal!).toBeLessThan(first!.endOrdinal!);
    expect(unb64(first!.payload!.base64).toString()).toBe("first");
    const rs = s.lifecycle.filter((r) => r.kind === "READY_STATE");
    expect(rs).toEqual([
      {
        ordinal: rs[0]!.ordinal,
        kind: "READY_STATE",
        value: 2,
        outcome: "RETURNED",
        exceptionCode: null,
      },
    ]);
    expect(s.instrumentation.complete).toBe(true);
  });

  it("R1b: exceptions from the inner transport are rethrown as the same object with only a fixed code kept", () => {
    const secretError = credError();
    const wrapperError = new Error("[CPMM_WS] SEND_THREW");
    let throwWhat: unknown = secretError;
    const listeners: ((...a: unknown[]) => void)[] = [];
    const inner = {
      readyState: 1,
      start: () => undefined,
      send: () => {
        throw throwWhat;
      },
      ping: () => undefined,
      pong: () => undefined,
      close: () => {
        throw new Error("[CPMM_WS] NOT_A_REAL_CODE");
      },
      terminate: () => {
        throw 42;
      },
      dispose: () => undefined,
      on: (_e: string, l: (...a: unknown[]) => void) => {
        listeners.push(l);
        return () => undefined;
      },
    } as unknown as CpmmOwnerTransport;
    const r = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const t = r.recordTransport(inner);
    expect(listeners.length).toBe(6);
    expect(thrown(() => t.send("a", () => undefined))).toBe(secretError);
    throwWhat = wrapperError;
    expect(thrown(() => t.send("b", () => undefined))).toBe(wrapperError);
    expect((thrown(() => t.close(1000)) as Error).message).toBe("[CPMM_WS] NOT_A_REAL_CODE");
    expect(thrown(() => t.terminate())).toBe(42);
    const s = r.finish(EMPTY_INPUT);
    expect(calls(s, "outgoing").map((c) => c.exceptionCode)).toEqual([
      "UNRECOGNIZED_EXCEPTION",
      "SEND_THREW",
    ]);
    expect(calls(s, "lifecycle").map((c) => [c.method, c.exceptionCode])).toEqual([
      ["close", "UNRECOGNIZED_EXCEPTION"],
      ["terminate", "NON_ERROR_THROWN"],
    ]);
    expectNoSecret(s);
    // Misuse never throws: a second or an unrecordable transport is returned unchanged.
    const r2 = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const notTransport = { start: 1 } as unknown as CpmmOwnerTransport;
    expect(r2.recordTransport(notTransport)).toBe(notTransport);
    const first = r2.recordTransport(inner);
    expect(first).not.toBe(inner);
    expect(r2.recordTransport(inner)).toBe(inner);
    expect(r2.finish(EMPTY_INPUT).instrumentation.retainedFailures.map((f) => f.code)).toEqual([
      "TRANSPORT_NOT_RECORDABLE",
      "TRANSPORT_ALREADY_RECORDED",
    ]);
  });

  it("R8a: nested events, removal mid-dispatch and events with no owner listener are each recorded once and attributed exactly", () => {
    const m = wrapped({});
    const seen: string[] = [];
    m.t.start();
    m.c.open();
    // An event with no owner listener ever registered.
    m.c.message(Buffer.from("orphan"));
    let nestedOnce = false;
    const offA = m.t.on("message", (d) => {
      const text = Buffer.from(d as Uint8Array).toString();
      seen.push(`A:${text}`);
      if (text === "outer" && !nestedOnce) {
        nestedOnce = true;
        m.c.message(Buffer.from("inner")); // nested dispatch of the same event
      }
    });
    let offC: () => void = () => undefined;
    const offB = m.t.on("message", (d) => {
      const text = Buffer.from(d as Uint8Array).toString();
      seen.push(`B:${text}`);
      if (text === "removal") offC(); // removes C before C's turn in this dispatch
      if (text === "inner") throw new Error("owner listener failure"); // contained by the wrapper
    });
    m.c.message(Buffer.from("outer"));
    expect(seen).toEqual(["A:outer", "A:inner", "B:inner", "B:outer"]);
    offC = m.t.on("message", () => {
      seen.push("C");
    });
    offA();
    const offD = m.t.on("message", () => {
      seen.push("D");
    });
    seen.length = 0;
    // Removal during dispatch: B removes C before C's turn; delivery stops at once.
    m.c.message(Buffer.from("removal"));
    expect(seen).toEqual(["B:removal", "D"]);
    seen.length = 0;
    m.c.message(Buffer.from("after"));
    expect(seen).toEqual(["B:after", "D"]);
    offB();
    offD();
    // After every owner listener is disposed, observation continues.
    m.c.message(Buffer.from("wrapper-only"));
    const s = m.r.finish(EMPTY_INPUT);
    const msgs = events(s, "incoming");
    expect(
      msgs.map((r) => [
        unb64(r.payload!.base64).toString(),
        r.eventIndex,
        r.ownerRegistrationsAtDispatch,
        r.ownerDeliveries,
        r.delivery,
      ]),
    ).toEqual([
      ["orphan", 1, 0, 0, "WRAPPER_ONLY_NO_OWNER_LISTENER"],
      ["outer", 2, 2, 2, "OWNER_LISTENERS_REGISTERED"],
      ["inner", 3, 2, 2, "OWNER_LISTENERS_REGISTERED"],
      ["removal", 4, 3, 2, "OWNER_LISTENERS_REGISTERED"], // B, C, D registered; C removed by B
      ["after", 5, 2, 2, "OWNER_LISTENERS_REGISTERED"],
      ["wrapper-only", 6, 0, 0, "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL"],
    ]);
    // Each event once, matching the wrapper's own count.
    expect(s.retention.incoming.observed).toBe(m.w.diagnostics().messages.delivered);
    expect(msgs[1]!.ordinal).toBeLessThan(msgs[2]!.ordinal);
    // B's nested delivery belongs to the inner record, not the outer one still being dispatched.
    expect(msgs.map((r) => r.ownerListenerThrew)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(m.w.diagnostics().ownerListenerThrew).toBe(1);
    expect(s.pending).toMatchObject({
      ownerRegistrationsLive: 0,
      dispatchesAwaitingOwnerDelivery: 0,
    });
    expect(s.instrumentation.complete).toBe(true);
    expect(s.lifecycle.filter((r) => r.kind === "UNREGISTER").length).toBe(4);
  });

  it("R8b: a close nested inside a message dispatch skips the remaining owner listeners, and the record says so", () => {
    const m = wrapped({});
    m.t.start();
    m.c.open();
    const seen: string[] = [];
    m.t.on("message", () => {
      seen.push("A");
      m.c.finishClose(1000);
    });
    m.t.on("message", () => seen.push("B"));
    m.t.on("close", (code) => seen.push(`close:${String(code)}`));
    m.c.message(Buffer.from("x"));
    expect(seen).toEqual(["A", "close:1000"]);
    const s = m.r.finish(EMPTY_INPUT);
    const [msg] = events(s, "incoming");
    expect(msg).toMatchObject({ ownerRegistrationsAtDispatch: 2, ownerDeliveries: 1 });
    const close = events(s, "lifecycle").find((r) => r.event === "close")!;
    expect(close).toMatchObject({ ownerDeliveries: 1, closeCode: 1000 });
    expect(close.ordinal).toBeGreaterThan(msg!.ordinal);
    // B's registration is still live in the owner's hands: the wait is explicit, not guessed.
    expect(s.pending.dispatchesAwaitingOwnerDelivery).toBe(1);
    expect(s.pending.ownerRegistrationsLive).toBe(3);
  });

  it("R4: retention allowances are separate; payloads are copied before mutation, omitted or dropped, and counted", () => {
    const m = wrapped(
      { complete: "sync" },
      {
        maxIncomingRecords: 2,
        maxIncomingPayloadBytes: 6,
        maxOutgoingRecords: 3,
        maxOutgoingPayloadBytes: 4,
        maxPayloadBytesPerRecord: 10,
        maxLifecycleRecords: 1,
      },
    );
    m.t.on("message", (d) => {
      (d as Uint8Array).fill(0xff); // the owner mutates what it received
    });
    m.t.start();
    m.c.open();
    m.c.message(Buffer.from("abcd")); // retained (4 of 6)
    m.c.message(Buffer.from("efgh")); // over the byte allowance: hashed, omitted
    m.c.message(Buffer.from("ijkl")); // over the record allowance: dropped
    m.t.send("1234", () => undefined); // call retained, payload 4 of 4
    m.t.send("5", () => undefined); // call over the record allowance after its completion... see below
    m.t.send("x".repeat(11), () => undefined); // oversize: neither copied nor hashed
    const s = m.r.finish(EMPTY_INPUT);
    const msgs = events(s, "incoming");
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.payload).toEqual({
      byteLength: 4,
      sha256: sha(Buffer.from("abcd")),
      base64: b64(Buffer.from("abcd")),
      omitted: null,
    });
    expect(msgs[1]!.payload).toEqual({
      byteLength: 4,
      sha256: sha(Buffer.from("efgh")),
      base64: null,
      omitted: "BYTE_ALLOWANCE",
    });
    expect(s.retention.incoming).toEqual({
      observed: 3,
      retained: 2,
      dropped: 1,
      payloadsOmitted: 1,
      retainedPayloadBytes: 4,
    });
    // Outgoing: call1, done1, call2 retained; done2, call3, done3 dropped.
    expect(s.outgoing.map((r) => r.kind)).toEqual(["CALL", "COMPLETION", "CALL"]);
    expect((s.outgoing[2] as CpmmRecordedCall).payload).toMatchObject({
      byteLength: 1,
      base64: null,
      omitted: "BYTE_ALLOWANCE",
    });
    expect(s.retention.outgoing).toEqual({
      observed: 6,
      retained: 3,
      dropped: 3,
      payloadsOmitted: 1,
      retainedPayloadBytes: 4,
    });
    // The lifecycle allowance is independent of the others.
    expect(s.retention.lifecycle.retained).toBe(1);
    expect(s.retention.lifecycle.dropped).toBeGreaterThan(0);
    expect(s.retention.recorderRetentionComplete).toBe(false);
    // Ordinals are assigned to dropped occurrences too: exact, never inferred.
    expect(s.ordinalsAssigned).toBeGreaterThan(
      s.incoming.length + s.outgoing.length + s.lifecycle.length,
    );
    // Oversize is never hashed.
    const big = wrapped({ complete: "sync" }, { maxPayloadBytesPerRecord: 10 });
    big.t.start();
    big.c.open();
    big.t.send("x".repeat(11), () => undefined);
    big.t.send("é".repeat(6), () => undefined); // 12 UTF-8 bytes from 6 UTF-16 units
    big.c.message(Buffer.alloc(11, 1));
    const bs = big.r.finish(EMPTY_INPUT);
    expect(calls(bs, "outgoing").map((c) => c.payload)).toEqual([
      { byteLength: null, sha256: null, base64: null, omitted: "OVERSIZE_NOT_HASHED" },
      { byteLength: 12, sha256: null, base64: null, omitted: "OVERSIZE_NOT_HASHED" },
    ]);
    expect(events(bs, "incoming")[0]!.payload).toEqual({
      byteLength: 11,
      sha256: null,
      base64: null,
      omitted: "OVERSIZE_NOT_HASHED",
    });
  });

  it("R3: outgoing and control attempts and completions: duplicate, failed, missing and throwing", () => {
    const twice = wrapped({ complete: "twice", autoPong: true });
    twice.t.start();
    twice.c.open();
    twice.t.ping(new Uint8Array([1, 2]), () => undefined);
    const payload = new Uint8Array([7, 7]);
    twice.t.pong(payload, () => undefined);
    payload[0] = 0; // caller mutation after the call
    return flush().then(() => {
      const s = twice.r.finish(EMPTY_INPUT);
      const ctl = calls(s, "control");
      expect(ctl.map((c) => [c.method, unb64(c.payload!.base64).toString("hex")])).toEqual([
        ["ping", "0102"],
        ["pong", "0707"],
      ]);
      expect(
        completions(s, "control").map((c) => [c.method, c.invocation, c.afterCallEnded]),
      ).toEqual([
        ["ping", 1, true],
        ["ping", 2, true],
        ["pong", 1, true],
        ["pong", 2, true],
      ]);
      const pongEvent = events(s, "control").find((r) => r.event === "pong")!;
      expect(unb64(pongEvent.payload!.base64).toString("hex")).toBe("0102");
      expect(s.pending.completionsAwaitingFirstCall).toEqual({ send: 0, ping: 0, pong: 0 });

      const failing = wrapped({ complete: "fail" });
      failing.t.start();
      failing.c.open();
      failing.t.send("a", () => undefined);
      return flush().then(() => {
        const fs = failing.r.finish(EMPTY_INPUT);
        expect(completions(fs, "outgoing")[0]).toMatchObject({ failedArgument: true });
        expectNoSecret(fs);

        const never = wrapped({ complete: "never", throwOn: { ping: true, close: true } });
        never.t.start();
        never.c.open();
        never.t.send("a", () => undefined);
        expect(
          (thrown(() => never.t.ping(new Uint8Array(1), () => undefined)) as Error).message,
        ).toBe("[CPMM_WS] PING_THREW");
        expect((thrown(() => never.t.close(1000)) as Error).message).toBe("[CPMM_WS] CLOSE_THREW");
        const ns = never.r.finish(EMPTY_INPUT);
        // Missing completions stay explicit, including the one for the call that threw.
        expect(ns.pending.completionsAwaitingFirstCall).toEqual({ send: 1, ping: 1, pong: 0 });
        expect(calls(ns, "control")[0]).toMatchObject({
          outcome: "THREW",
          exceptionCode: "PING_THREW",
        });
        expect(calls(ns, "lifecycle").find((c) => c.method === "close")).toMatchObject({
          outcome: "THREW",
          exceptionCode: "CLOSE_THREW",
          closeCodeArgument: 1000,
        });
        expectNoSecret(ns);
      });
    });
  });

  it("R8c: finish is idempotent, detaches observation only, and later callbacks keep their behaviour without touching the snapshot", async () => {
    const m = wrapped({ complete: "never" });
    m.t.start();
    m.c.open();
    const got: string[] = [];
    const off = m.t.on("message", (d) => got.push(Buffer.from(d as Uint8Array).toString()));
    const doneCalls: boolean[] = [];
    m.t.send("pending", (failed) => doneCalls.push(failed));
    const callsBefore = m.c.calls.length;
    const s = m.r.finish(EMPTY_INPUT);
    expect(m.r.finish({ ...EMPTY_INPUT, epoch: 99 })).toBe(s);
    expectDeepFrozen(s);
    const json = JSON.stringify(s);
    // Nothing was closed, terminated or stopped by finish().
    expect(m.c.calls.length).toBe(callsBefore);
    expect(m.w.diagnostics().lifecycle).toBe("ACTIVE");
    expect(s.pending).toMatchObject({
      ownerRegistrationsLive: 1,
      completionsAwaitingFirstCall: { send: 1, ping: 0, pong: 0 },
    });
    // Later: the owner listener still receives; the completion still reaches done.
    m.c.message(Buffer.from("late"));
    m.c.pending[0]!();
    m.t.send("after", () => undefined);
    expect(got).toEqual(["late"]);
    expect(doneCalls).toEqual([false]);
    expect(JSON.stringify(s)).toBe(json);
    expect(m.r.lateActivity()).toEqual({
      wrapperEvents: 0,
      ownerDeliveries: 1,
      ownerListenerThrows: 0,
      transportCalls: 1,
      registrations: 0,
      completions: 1,
      completionThrows: 0,
      ledgerCalls: 0,
      ledgerSettlements: 0,
      exchanges: 0,
    });
    off();
    // Re-entrant finish from inside a component read is refused, and recorded as a read failure.
    const r = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    let inner: unknown = null;
    const rs = r.finish({
      ...EMPTY_INPUT,
      wrapper: {
        diagnostics: () => {
          inner = thrown(() => r.finish(EMPTY_INPUT));
          throw inner;
        },
      } as unknown as CpmmObservationFinishInput["wrapper"],
    });
    expect((inner as Error).message).toBe("[CPMM_RECORDER] FINISH_REENTERED");
    expect(rs.components.wrapperDiagnostics).toEqual({ status: "READ_FAILED", code: "THREW" });
    expect(rs.instrumentation.complete).toBe(false);
  });

  it("R8d: finish copies component reads within a node budget and never freezes or mutates caller objects", () => {
    const records = [{ sequence: 1, sha256: null, receivedAtMs: null, nested: { a: [1, 2] } }];
    const collector = {
      epochReport: () => ({ epoch: 1 }),
      frameRecords: () => records,
      notifications: () => [],
      counters: () => ({ frames: 1 }),
    };
    const report = { terminal: { cause: "OBSERVATION_COMPLETED" } };
    const input = {
      ...EMPTY_INPUT,
      report: report as unknown as CpmmConnectionRunReport,
      collector: collector as unknown as CpmmObservationFinishInput["collector"],
      wrapper: {
        diagnostics: () => ({
          get bad() {
            return 1;
          },
        }),
      } as unknown as CpmmObservationFinishInput["wrapper"],
      session: {
        getLedgerSince: () => new Proxy([], {}),
        getLedgerLength: () => 3,
      } as unknown as CpmmObservationFinishInput["session"],
      sessionLedgerStart: 0,
    };
    const r = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const s = r.finish(input);
    expect(Object.isFrozen(records)).toBe(false);
    expect(Object.isFrozen(records[0])).toBe(false);
    expect(Object.isFrozen(report)).toBe(false);
    expect(Object.isFrozen(input)).toBe(false);
    expect(s.components.collectorFrameRecords).toEqual({ status: "READ", value: records });
    expect((s.components.collectorFrameRecords as { value: unknown[] }).value[0]).not.toBe(
      records[0],
    );
    expect(s.components.wrapperDiagnostics).toEqual({ status: "READ_FAILED", code: "ACCESSOR" });
    expect(s.components.sessionLedgerWindow).toEqual({ status: "READ_FAILED", code: "PROXY" });
    expect(s.components.sessionLedgerEndLength).toEqual({ status: "READ", value: 3 });
    expect(s.components.ledgerRecords).toEqual({ status: "NOT_SUPPLIED" });
    records[0]!.sequence = 2;
    expect(
      (s.components.collectorFrameRecords as { value: { sequence: number }[] }).value[0]!.sequence,
    ).toBe(1);
    // The node budget bounds copying: later sections fail explicitly.
    const tight = createCpmmPoolObservationRecorder({
      limits: { ...RLIMITS, maxFinishCopyNodes: 4 },
    });
    const ts = tight.finish(input);
    expect(ts.components.report).toEqual({ status: "READ", value: report });
    expect(ts.components.collectorFrameRecords).toEqual({
      status: "READ_FAILED",
      code: "COPY_LIMIT",
    });
    expect(ts.instrumentation.complete).toBe(false);
    // An invalid input is not trusted at all.
    const bad = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const bs = bad.finish(new Proxy({ ...input }, {}) as unknown as CpmmObservationFinishInput);
    expect(bs.components.collectorCounters).toEqual({ status: "NOT_SUPPLIED" });
    expect(bs.instrumentation.retainedFailures.map((f) => f.code)).toEqual([
      "FINISH_INPUT_INVALID",
    ]);
  });

  it("R9: the delegating ledger returns the original promise object and observes settlement without changing it", async () => {
    const resolved = Promise.resolve(
      Object.freeze({
        status: "DUPLICATE",
        occurrence: 2,
        firstSequence: 1,
        detail: {},
        detailRetained: true,
      }),
    );
    const rejected = Promise.reject(credError());
    rejected.catch(() => undefined); // the caller's own handling
    let never: (v: unknown) => void = () => undefined;
    const pending = new Promise((res) => {
      never = res;
    });
    const thrownError = credError();
    const results: unknown[] = [resolved, rejected, pending, 7];
    const stub = {
      version: 5,
      getBinding: () => "binding",
      openEpoch: (x: unknown) => ({ opened: x }),
      epochs: () => [],
      counters: () => ({}),
      records: () => [],
      summarize: () => null,
      account: () => {
        if (results.length === 0) throw thrownError;
        return results.shift();
      },
    } as unknown as CpmmResolutionAccountingLedger;
    const r = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const d = r.recordLedger(stub);
    // (Compared by identity only: an equality hint would read the delegate's version getter.)
    expect(d === stub).toBe(false);
    const envelope = Object.freeze({
      notification: Object.freeze({ signature: signatureOf(1) }),
      epoch: 1,
      hostReceivedAtMs: RECEIVED_AT,
    });
    expect(d.account(envelope as never, undefined)).toBe(resolved);
    expect(d.account(envelope as never, undefined)).toBe(rejected);
    expect(d.account(envelope as never, undefined)).toBe(pending);
    expect(d.account(envelope as never, undefined)).toBe(7);
    expect(thrown(() => d.account(envelope as never, undefined))).toBe(thrownError);
    expect(d.openEpoch({ epoch: 3, observationStartMs: 1 } as never)).toEqual({
      opened: { epoch: 3, observationStartMs: 1 },
    });
    expect(d.version).toBe(5);
    await flush();
    const s = r.finish(EMPTY_INPUT);
    expect(Object.isFrozen(envelope)).toBe(true); // caller's own freeze, unchanged
    const accountCalls = s.ledgerCalls.filter(
      (x): x is CpmmRecordedAccountCall => x.kind === "ACCOUNT_CALL",
    );
    expect(
      accountCalls.map((c) => [c.call, c.signature, c.epoch, c.hostReceivedAtMs, c.outcome]),
    ).toEqual([
      [1, signatureOf(1), 1, RECEIVED_AT, "RETURNED"],
      [2, signatureOf(1), 1, RECEIVED_AT, "RETURNED"],
      [3, signatureOf(1), 1, RECEIVED_AT, "RETURNED"],
      [4, signatureOf(1), 1, RECEIVED_AT, "RETURNED"],
      [5, signatureOf(1), 1, RECEIVED_AT, "THREW"],
    ]);
    const settlements = s.ledgerCalls.filter(
      (x): x is CpmmRecordedAccountSettlement => x.kind === "ACCOUNT_SETTLEMENT",
    );
    expect(settlements.map((x) => [x.call, x.outcome, x.status, x.firstSequence])).toEqual([
      [1, "FULFILLED", "DUPLICATE", 1],
      [2, "REJECTED", null, null],
    ]);
    expect(s.pending).toMatchObject({ accountSettlementsPending: 1, accountCallsInProgress: 0 });
    expect(s.instrumentation.retainedFailures.map((f) => f.code)).toEqual([
      "ACCOUNT_RESULT_NOT_PROMISE",
      "ACCOUNT_REJECTED",
    ]);
    expect(s.delegatedLedgerCalls).toMatchObject({ openEpoch: 1, version: 1, records: 0 });
    // A settlement after finish is counted, never recorded.
    never({ status: "RECORDED" });
    await flush();
    expect(r.lateActivity().ledgerSettlements).toBe(1);
    expect(s.ledgerCalls.length).toBe(7);
    expect(unhandled).toEqual([]);
    expectNoSecret(s);
    // The real accepted ledger: the promise its account() created is the one returned.
    const real = env({ record: false }).ledger;
    const created: unknown[] = [];
    const original = real.account.bind(real);
    Object.defineProperty(real, "account", {
      value: (...a: Parameters<CpmmResolutionAccountingLedger["account"]>) => {
        const p = original(...a);
        created.push(p);
        return p;
      },
    });
    const r3 = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const got = r3.recordLedger(real).account({} as never);
    expect(created.length).toBe(1);
    expect(got).toBe(created[0]);
    expect(await got).toMatchObject({ status: "INVALID", code: "ENVELOPE_INVALID" });
    const s3 = r3.finish(EMPTY_INPUT);
    expect(s3.ledgerCalls.map((x) => x.kind)).toEqual(["ACCOUNT_CALL", "ACCOUNT_SETTLEMENT"]);
    expect(s3.ledgerCalls[1]).toMatchObject({ status: "INVALID", code: "ENVELOPE_INVALID" });
  });

  it("R5a: the fan-out runs every observer in fixed order and isolates throws, returns, rejections and never-settling thenables", async () => {
    const order: string[] = [];
    let revoke: () => void = () => undefined;
    const throwingThen = {
      get then(): unknown {
        throw credError();
      },
    };
    const returns: unknown[] = [
      undefined,
      5,
      Promise.reject(credError()),
      new Promise(() => undefined),
      throwingThen,
      (() => {
        const p = Proxy.revocable({}, {});
        revoke = p.revoke;
        return p.proxy;
      })(),
    ];
    revoke();
    const observers = returns.map((ret, i) => ({
      label: `o${i}`,
      observe: (() => {
        order.push(`o${i}`);
        return ret;
      }) as unknown as (e: PaperRequestExchangeEvidence) => void,
    }));
    observers.splice(1, 0, {
      label: "thrower",
      observe: () => {
        order.push("thrower");
        throw credError();
      },
    });
    const fan = createExchangeObserverFanOut({ observers, maxRetainedFailures: 3 });
    const ev = {} as PaperRequestExchangeEvidence;
    expect(fan.observe(ev)).toBeUndefined();
    expect(order).toEqual(["o0", "thrower", "o1", "o2", "o3", "o4", "o5"]);
    // Incomplete at once, before any rejection is observed.
    const now = fan.diagnostics();
    expect(now.instrumentationComplete).toBe(false);
    expect(now.observers.map((o) => [o.label, o.threw, o.unexpectedReturns, o.rejected])).toEqual([
      ["o0", 0, 0, 0],
      ["thrower", 1, 0, 0],
      ["o1", 0, 1, 0],
      ["o2", 0, 1, 0],
      ["o3", 0, 1, 0],
      ["o4", 0, 1, 0],
      ["o5", 0, 1, 0],
    ]);
    await flush();
    const later = fan.diagnostics();
    expect(later.observers.map((o) => o.rejected)).toEqual([0, 0, 0, 1, 0, 1, 1]);
    expect(later.failures).toBe(9);
    expect(later.retainedFailures.length).toBe(3);
    expect(later.droppedFailureRecords).toBe(6);
    expect(later.observers[1]!.firstFailureInvocation).toBe(1);
    expect(Object.isFrozen(later.observers[0])).toBe(true);
    expectNoSecret(later);
    expect(unhandled).toEqual([]);
    // Validation.
    const ok = { label: "a", observe: () => undefined };
    for (const bad of [
      { observers: [], maxRetainedFailures: 1 },
      { observers: [ok, ok], maxRetainedFailures: 1 },
      { observers: [{ label: "bad label", observe: () => undefined }], maxRetainedFailures: 1 },
      { observers: [{ label: "a", observe: 1 }], maxRetainedFailures: 1 },
      { observers: [ok], maxRetainedFailures: -1 },
      { observers: [ok], maxRetainedFailures: 1, extra: true },
      { observers: new Proxy([ok], {}), maxRetainedFailures: 1 },
    ]) {
      expect(() => createExchangeObserverFanOut(bad as never)).toThrow(/^\[CPMM_FANOUT_INIT\]/);
    }
  });

  it("R5b: exchanges: CPMM bodies copied before mutation with fixed labels; other traffic counted without bodies; URL never kept", () => {
    const r = createCpmmPoolObservationRecorder({
      limits: { ...RLIMITS, maxExchangeBodyBytes: 10, maxExchangeRecords: 2 },
    });
    const body = Buffer.from('{"id":3}');
    const entry = {
      seq: 4,
      lane: "SOLANA_RPC",
      owner: "PAPER_CANDIDATE",
      purpose: CPMM_TX_PURPOSE,
      requestedIdentity: signatureOf(1),
      jsonRpcId: 3,
      dispatchedAtMs: RECEIVED_AT + 1,
      completedAtMs: null,
      httpStatus: null,
      bodyComplete: false,
      error: "REQUEST_TIMED_OUT",
    };
    const ev = {
      entry,
      method: "POST",
      url: RPC_URL,
      requestBody: `{"jsonrpc":"2.0","id":3,"method":"getTransaction","params":["${signatureOf(1)}"]}`,
      responseHeaders: { "content-type": "application/json" },
      bodyState: "PARTIAL_OVERFLOW",
      body,
      observedBodyBytes: 900,
      maxResponseBytes: 8,
    };
    r.observeExchange(ev as unknown as PaperRequestExchangeEvidence);
    body.fill(0); // later mutation by anyone
    r.observeExchange({
      ...ev,
      entry: { ...entry, seq: 5, error: `fetch failed ${RPC_URL}` },
      body: Buffer.from("01234567890"),
    } as unknown as PaperRequestExchangeEvidence);
    r.observeExchange({
      ...ev,
      entry: { ...entry, seq: 6 },
    } as unknown as PaperRequestExchangeEvidence);
    for (const purpose of ["POOL_STATE", "POOL_STATE", "x y z"]) {
      r.observeExchange({
        ...ev,
        entry: { ...entry, purpose },
      } as unknown as PaperRequestExchangeEvidence);
    }
    expect(r.observeExchange(null as unknown as PaperRequestExchangeEvidence)).toBeUndefined();
    const s = r.finish(EMPTY_INPUT);
    expect(Object.isFrozen(ev)).toBe(false);
    expect(s.exchanges.length).toBe(2);
    const [first, second] = s.exchanges;
    expect(first).toMatchObject({
      endpoint: CPMM_EXCHANGE_ENDPOINT_LABEL,
      method: "POST",
      bodyState: "PARTIAL_OVERFLOW",
      observedBodyBytes: 900,
      maxResponseBytes: 8,
      responseHeaders: { "content-type": "application/json" },
      entry: {
        seq: 4,
        jsonRpcId: 3,
        requestedIdentity: signatureOf(1),
        dispatchedAtMs: RECEIVED_AT + 1,
        completedAtMs: null,
        httpStatus: null,
        error: "REQUEST_TIMED_OUT",
      },
    });
    expect(unb64(first!.body!.base64).toString()).toBe('{"id":3}');
    expect(first!.body!.sha256).toBe(sha(Buffer.from('{"id":3}')));
    expect(second!.entry.error).toBe("UNRECOGNIZED");
    expect(second!.body).toMatchObject({ byteLength: 11, base64: null, omitted: "BYTE_ALLOWANCE" });
    expect(s.retention.exchanges).toMatchObject({ observed: 3, retained: 2, dropped: 1 });
    expect(s.otherExchanges).toEqual({
      total: 4,
      byKey: [
        { lane: "SOLANA_RPC", owner: "PAPER_CANDIDATE", purpose: "POOL_STATE", count: 2 },
        { lane: "SOLANA_RPC", owner: "PAPER_CANDIDATE", purpose: "UNRECOGNIZED", count: 1 },
        // Not an evidence object at all: counted, never recorded.
        { lane: "UNRECOGNIZED", owner: "UNRECOGNIZED", purpose: "UNRECOGNIZED", count: 1 },
      ],
      keysOverflowed: 0,
    });
    expectNoSecret(s);
    expect(JSON.stringify(s).includes("url")).toBe(false);
    r.observeExchange(ev as unknown as PaperRequestExchangeEvidence);
    expect(r.lateActivity().exchanges).toBe(1);
  });

  it("R7: source boundary: no clock, timer, network, file, environment, console or redaction use", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./CpmmPoolObservationRecorder.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:util",
      "./CpmmPoolConnectionOwner.js",
      "./CpmmPoolNotificationCollector.js",
      "./CpmmPoolWebSocketTransport.js",
      "./CpmmResolutionAccountingLedger.js",
      "./PaperRequestSession.js",
      "./RaydiumCpmmTransactionSourceAdapter.js",
    ]);
    // Everything but the purpose constant and node built-ins is a type-only import.
    expect(code).toMatch(
      /import \{ CPMM_TX_PURPOSE \} from "\.\/RaydiumCpmmTransactionSourceAdapter\.js"/,
    );
    expect(code.match(/^import type /gm)?.length).toBe(5);
    for (const banned of [
      /\bDate\b/,
      /\bperformance\b/,
      /\bprocess\b/,
      /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/,
      /\bconsole\b/,
      /\bfetch\b/,
      /\brequire\(/,
      /\bimport\(/,
      /node:(fs|net|http|https|tls|dns|child_process|os|worker_threads)/,
      /\bWebSocket\b/,
      /\bsanitiz|\bredact|credential-sanitizer/i,
      /\.url\b|"url"/,
    ]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
  });
});

describe("Integration: the real owner, wrapper, collector, ledger, adapter and session", () => {
  it("R1c+R6: owner report, wrapper diagnostics, session ledger and ledger records are identical with and without the recorder; the binding chain holds", async () => {
    const base = env({ record: false, client: { autoPong: true } });
    const baseReport = await scenario(base);
    const e = env({ client: { autoPong: true } });
    const report = await scenario(e);
    expect(report).toEqual(baseReport);
    expect(e.w.diagnostics()).toEqual(base.w.diagnostics());
    expect(e.c.calls).toEqual(base.c.calls);
    expect(e.session.getLedgerSince(0)).toEqual(base.session.getLedgerSince(0));
    expect(e.ledger.records()).toEqual(base.ledger.records());
    expect(e.owner.lateEvents()).toEqual(base.owner.lateEvents());
    expect(report.connectionRunClean).toBe(true);
    // The fan-out fed the adapter's evidence recorder first, then the recorder.
    expect(e.order).toEqual(["adapter", "recorder"]);
    const s = e.recorder.finish(e.input(report));
    expect(s.instrumentation.complete).toBe(true);
    expect(s.retention.recorderRetentionComplete).toBe(true);
    // Binding chain: session entry = request body = response id = account() call = ledger record.
    const [exchange] = s.exchanges;
    expect(s.exchanges.length).toBe(1);
    const sig = signatureOf(1);
    expect(exchange!.entry).toMatchObject({ purpose: CPMM_TX_PURPOSE, requestedIdentity: sig });
    const requestJson = JSON.parse(unb64(exchange!.requestBody!.base64).toString());
    expect(requestJson).toMatchObject({
      id: exchange!.entry.jsonRpcId,
      params: [sig, expect.anything()],
    });
    expect(JSON.parse(unb64(exchange!.body!.base64).toString()).id).toBe(exchange!.entry.jsonRpcId);
    expect(exchange!.bodyState).toBe("COMPLETE");
    const accountCalls = s.ledgerCalls.filter(
      (x): x is CpmmRecordedAccountCall => x.kind === "ACCOUNT_CALL",
    );
    const settlements = s.ledgerCalls.filter(
      (x): x is CpmmRecordedAccountSettlement => x.kind === "ACCOUNT_SETTLEMENT",
    );
    expect(accountCalls.map((c) => c.signature)).toEqual([sig, sig]);
    expect(settlements.map((x) => x.status)).toEqual(["RECORDED", "DUPLICATE"]);
    const ledgerRecords = e.ledger.records();
    expect(settlements[0]).toMatchObject({
      signature: sig,
      recordSequence: ledgerRecords[0]!.sequence,
      factKind: ledgerRecords[0]!.factKind,
      factCode: ledgerRecords[0]!.factCode,
      disposition: ledgerRecords[0]!.disposition,
    });
    expect(settlements[1]!.firstSequence).toBe(ledgerRecords[0]!.sequence);
    // The duplicate made no request; the session window is the single authoritative ledger.
    const window = s.components.sessionLedgerWindow as { status: string; value: { seq: number }[] };
    expect(window.status).toBe("READ");
    expect(window.value.map((x) => x.seq)).toEqual([exchange!.entry.seq]);
    expect(s.components.sessionLedgerEndLength).toEqual({
      status: "READ",
      value: e.sessionLedgerStart + 1,
    });
    // Times are copied from the components that read them; the recorder invents none.
    const frames = (s.components.collectorFrameRecords as { value: CpmmFrameRecord[] }).value;
    const notifFrame = frames.find((fr) => fr.disposition === "NOTIFICATION_ACCEPTED")!;
    expect(accountCalls[0]!.hostReceivedAtMs).toBe(notifFrame.receivedAtMs);
    expect(exchange!.entry.dispatchedAtMs).toBe(e.session.getLedgerSince(0)[0]!.dispatchedAtMs);
    // Outgoing subscribe and unsubscribe bytes, ping/pong both ways.
    const sends = calls(s, "outgoing");
    expect(sends.map((c) => JSON.parse(unb64(c.payload!.base64).toString()).method)).toEqual([
      "logsSubscribe",
      "logsUnsubscribe",
    ]);
    expect(completions(s, "outgoing").length).toBe(2);
    expect(
      events(s, "control")
        .map((x) => x.event)
        .sort(),
    ).toEqual(["ping", ...Array(report.outgoing.pongsMatched).fill("pong")].sort());
    expect(calls(s, "control").filter((c) => c.method === "pong").length).toBe(1);
    expect(s.delegatedLedgerCalls.openEpoch).toBe(1);
    expect(s.components.fanOutDiagnostics).toMatchObject({
      status: "READ",
      value: { instrumentationComplete: true, invocations: 1 },
    });
    expectDeepFrozen(s);
    expect(unhandled).toEqual([]);
  });

  it("R8e: two owner messages versus three wrapper deliveries, and an actual close after a FAILED_STILL_OPEN settlement", async () => {
    const e = env({ client: { autoPong: true, closeMode: "none" } });
    const { p } = await startAndAck(e);
    await e.to(NOMINAL_END);
    e.c.message(unsubAck());
    await flush();
    e.c.message(enc({ jsonrpc: "2.0", method: "late" })); // after intake stopped
    await e.to(NOMINAL_END + OWNER_LIMITS.cleanupTimeoutMs + 10);
    const r = await p;
    expect(r.cleanup).toMatchObject({ status: "FAILED_STILL_OPEN", terminateAttempted: true });
    expect(r.incoming.messageEvents).toBe(2);
    expect(r.cleanup.closeCode).toBeNull();
    // The socket actually closes after settlement; the owner has no listener any more.
    e.c.finishClose(1006);
    expect(e.owner.lateEvents().close).toBe(0);
    const s = e.recorder.finish(e.input(r));
    const msgs = events(s, "incoming");
    expect(msgs.length).toBe(3);
    expect(e.w.diagnostics().messages.delivered).toBe(3);
    expect(msgs.filter((m) => m.ownerDeliveries > 0).length).toBe(r.incoming.messageEvents);
    expect(msgs[2]).toMatchObject({
      ownerDeliveries: 0,
      delivery: "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL",
    });
    const closes = events(s, "lifecycle").filter((x) => x.event === "close");
    expect(closes).toEqual([
      expect.objectContaining({
        ownerDeliveries: 0,
        ownerRegistrationsAtDispatch: 0,
        delivery: "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL",
        closeCode: 1006,
      }),
    ]);
    // Both observations kept apart: the frozen owner report and the later wrapper diagnostics.
    const report = s.components.report as { value: CpmmConnectionRunReport };
    expect(report.value.cleanup.closeCode).toBeNull();
    expect(s.components.wrapperDiagnostics).toMatchObject({
      status: "READ",
      value: { close: { observed: true, deliveredCode: 1006 } },
    });
    // Cleanup calls as the owner made them: close(1000), terminate, the readyState read.
    expect(calls(s, "lifecycle").map((c) => [c.method, c.outcome])).toEqual([
      ["start", "RETURNED"],
      ["close", "RETURNED"],
      ["terminate", "RETURNED"],
    ]);
    expect(s.lifecycle.find((x) => x.kind === "READY_STATE")).toMatchObject({ value: 2 });
    // The owner disposed every listener: nothing awaits delivery.
    expect(s.pending).toMatchObject({
      ownerRegistrationsLive: 0,
      dispatchesAwaitingOwnerDelivery: 0,
    });
    expect(s.instrumentation.complete).toBe(true);
  });

  it("R2: a collector refusal stays unhashed and untimed in the collector's record while the recorder keeps its own digest", async () => {
    const e = env({ client: { autoPong: true }, collectorLimits: { maxEpochFrames: 2 } });
    const { p } = await startAndAck(e);
    await e.to(RECEIVED_AT);
    e.c.message(notif(1)); // no scripted response: the request fails; that is fine here
    await flush();
    e.c.message(notif(2));
    await e.to(RECEIVED_AT + 5_000);
    const r = await p;
    const s = e.recorder.finish(e.input(r));
    const frames = (s.components.collectorFrameRecords as { value: CpmmFrameRecord[] }).value;
    const refused = frames.filter((fr) => fr.disposition === "EPOCH_LIMIT_EXCEEDED");
    expect(refused.length).toBe(1);
    expect(refused[0]).toMatchObject({ sha256: null, receivedAtMs: null });
    // Association by order and length (the sealer's job): the recorder's own digest is separate.
    const handedOver = events(s, "incoming").filter((x) => x.ownerDeliveries > 0);
    const k = frames.indexOf(refused[0]!);
    expect(handedOver[k]!.payload).toMatchObject({
      byteLength: refused[0]!.byteLength,
      sha256: sha(notif(2)),
    });
    expect(r.incoming.passedToCollector).toBe(frames.length);
  });

  it("R5c: a throwing, rejecting and never-settling observer after the recorder changes nothing for the session, adapter or owner", async () => {
    const extra = [
      {
        label: "throws",
        observe: () => {
          throw credError();
        },
      },
      {
        label: "rejects",
        observe: (() => Promise.reject(credError())) as unknown as (
          e: PaperRequestExchangeEvidence,
        ) => void,
      },
      {
        label: "never",
        observe: (() => new Promise(() => undefined)) as unknown as (
          e: PaperRequestExchangeEvidence,
        ) => void,
      },
    ];
    const base = env({ client: { autoPong: true } });
    const baseReport = await scenario(base);
    const e = env({ client: { autoPong: true }, extraObservers: extra });
    const report = await scenario(e);
    expect(report).toEqual(baseReport);
    expect(e.ledger.records()).toEqual(base.ledger.records());
    expect(e.session.getLedgerSince(0)).toEqual(base.session.getLedgerSince(0));
    const d = e.fanOut.diagnostics();
    expect(d.instrumentationComplete).toBe(false);
    expect(
      d.observers.map((o) => [o.label, o.calls, o.threw, o.unexpectedReturns, o.rejected]),
    ).toEqual([
      ["adapter-evidence", 1, 0, 0, 0],
      ["observation-recorder", 1, 0, 0, 0],
      ["throws", 1, 1, 0, 0],
      ["rejects", 1, 0, 1, 1],
      ["never", 1, 0, 1, 0],
    ]);
    const s = e.recorder.finish(e.input(report));
    expect(s.exchanges.length).toBe(1);
    expect(s.components.fanOutDiagnostics).toMatchObject({
      value: { instrumentationComplete: false, failures: 4 },
    });
    expectNoSecret(s.components.fanOutDiagnostics);
    expect(unhandled).toEqual([]);
  });
});

describe("R10: the finalization boundary (finish() refused while a recorder callback runs)", () => {
  const REFUSED = "[CPMM_RECORDER] FINISH_DURING_CALLBACK";

  it("R10a: an asynchronous completion and an owner listener that finish and then throw are recorded truthfully", async () => {
    const m = wrapped({ complete: "microtask" });
    m.t.start();
    m.c.open();
    const refusals: unknown[] = [];
    m.t.send("x", () => {
      refusals.push(thrown(() => m.r.finish(EMPTY_INPUT)));
      throw new Error("done failure");
    });
    m.t.on("message", (d) => {
      if (Buffer.from(d as Uint8Array).toString() !== "m") return;
      refusals.push(thrown(() => m.r.finish(EMPTY_INPUT)));
      throw new Error("listener failure");
    });
    await flush();
    m.c.message(Buffer.from("m"));
    expect(refusals.map((e) => (e as Error).message)).toEqual([REFUSED, REFUSED]);
    expect(m.w.diagnostics().completions.doneThrew).toBe(1);
    expect(m.w.diagnostics().ownerListenerThrew).toBe(1);
    // The refusal latched nothing: recording continued, and finish() succeeds afterwards.
    m.c.message(Buffer.from("after-refusal"));
    const s = m.r.finish(EMPTY_INPUT);
    expect(completions(s, "outgoing").map((c) => [c.invocation, c.doneThrew])).toEqual([[1, true]]);
    expect(events(s, "incoming").map((r) => [r.ownerDeliveries, r.ownerListenerThrew])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(s.pending.completionsAwaitingFirstCall).toEqual({ send: 0, ping: 0, pong: 0 });
    expect(s.instrumentation.complete).toBe(true);
    expect(m.r.lateActivity()).toMatchObject({
      ownerDeliveries: 0,
      ownerListenerThrows: 0,
      completions: 0,
      completionThrows: 0,
    });
  });

  it("R10b: nested callbacks refuse at every depth until the outermost returns", () => {
    const m = wrapped({ complete: "sync" });
    m.t.start();
    m.c.open();
    const attempts: string[] = [];
    const attempt = (label: string) => {
      try {
        m.r.finish(EMPTY_INPUT);
        attempts.push(`${label}:finished`);
      } catch (e) {
        attempts.push(`${label}:${(e as Error).message === REFUSED ? "refused" : "other"}`);
      }
    };
    m.t.on("message", (d) => {
      const text = Buffer.from(d as Uint8Array).toString();
      if (text === "outer") {
        m.c.message(Buffer.from("inner")); // nested listener invocation
        // A synchronous completion inside the listener: done is a nested callback too.
        m.t.send("s", () => attempt("done-in-listener"));
        attempt("outer-after-nested");
      } else attempt("inner");
    });
    m.c.message(Buffer.from("outer"));
    expect(attempts).toEqual([
      "inner:refused",
      "done-in-listener:refused",
      "outer-after-nested:refused",
    ]);
    // Once every callback has returned, the first finish() succeeds and is final.
    const s = m.r.finish(EMPTY_INPUT);
    expect(m.r.finish(EMPTY_INPUT)).toBe(s);
    expect(events(s, "incoming").map((r) => [r.ownerDeliveries, r.ownerListenerThrew])).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(completions(s, "outgoing")).toEqual([
      expect.objectContaining({ invocation: 1, afterCallEnded: false, doneThrew: false }),
    ]);
    expect(s.instrumentation.complete).toBe(true);
  });

  it("R10c: callbacks keep their receiver, arguments, return values and thrown objects", () => {
    const listeners: ((...a: unknown[]) => unknown)[] = [];
    const dones: ((...a: unknown[]) => unknown)[] = [];
    const inner = {
      readyState: 1,
      start: () => undefined,
      send: (_d: unknown, done: (...a: unknown[]) => unknown) => {
        dones.push(done);
      },
      ping: () => undefined,
      pong: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
      dispose: () => undefined,
      on: (_e: string, l: (...a: unknown[]) => unknown) => {
        listeners.push(l);
        return () => undefined;
      },
    } as unknown as CpmmOwnerTransport;
    const r = createCpmmPoolObservationRecorder({ limits: RLIMITS });
    const t = r.recordTransport(inner);
    const seen: { self: unknown; args: unknown[] }[] = [];
    const failure = new Error("same object");
    let fail = false;
    t.on("message", function (this: unknown, ...args: unknown[]) {
      seen.push({ self: this, args });
      if (fail) throw failure;
      return "listener-result";
    } as unknown as (d: unknown) => void);
    t.send("x", function (this: unknown, ...args: unknown[]) {
      seen.push({ self: this, args });
      if (fail) throw failure;
      return "done-result";
    } as unknown as (failed: boolean) => void);
    const ownerShim = listeners[6]!; // after the six observation listeners
    const receiver = { receiver: true };
    const payload = new Uint8Array([1]);
    listeners[1]!.call(undefined, payload); // the observation listener for "message"
    expect(ownerShim.call(receiver, payload, "extra")).toBe("listener-result");
    expect(dones[0]!.call(receiver, false, "extra")).toBe("done-result");
    fail = true;
    expect(thrown(() => ownerShim.call(receiver, payload))).toBe(failure);
    expect(thrown(() => dones[0]!.call(receiver, true))).toBe(failure);
    expect(seen.map((x) => [x.self, x.args])).toEqual([
      [receiver, [payload, "extra"]],
      [receiver, [false, "extra"]],
      [receiver, [payload]],
      [receiver, [true]],
    ]);
    expect(seen[0]!.args[0]).toBe(payload);
    const s = r.finish(EMPTY_INPUT);
    expect(completions(s, "outgoing").map((c) => [c.invocation, c.doneThrew])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("R10d: after a successful finish(), later callbacks forward unchanged, finish() returns the same snapshot, and late throws are counted", () => {
    const m = wrapped({ complete: "never" });
    m.t.start();
    m.c.open();
    let s: CpmmObservationSnapshot | null = null;
    const inside: unknown[] = [];
    m.t.on("message", () => {
      inside.push(m.r.finish(EMPTY_INPUT));
      throw new Error("late listener failure");
    });
    m.t.send("x", () => {
      inside.push(m.r.finish(EMPTY_INPUT));
      throw new Error("late done failure");
    });
    s = m.r.finish(EMPTY_INPUT);
    const json = JSON.stringify(s);
    expect(s.pending.completionsAwaitingFirstCall).toEqual({ send: 1, ping: 0, pong: 0 });
    m.c.message(Buffer.from("late"));
    m.c.pending[0]!();
    expect(inside).toEqual([s, s]);
    expect(inside[0]).toBe(s);
    expect(m.w.diagnostics().ownerListenerThrew).toBe(1);
    expect(m.w.diagnostics().completions.doneThrew).toBe(1);
    expect(m.r.lateActivity()).toMatchObject({
      ownerDeliveries: 1,
      ownerListenerThrows: 1,
      completions: 1,
      completionThrows: 1,
    });
    expect(JSON.stringify(s)).toBe(json);
    expectDeepFrozen(s);
  });
});
