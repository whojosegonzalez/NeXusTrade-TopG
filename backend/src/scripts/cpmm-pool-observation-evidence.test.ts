/**
 * CPMM pool observation evidence: synthetic offline tests for sealing and integrity verification
 * (assessment §8.38.17 item 17 D–F).
 *
 * Every snapshot is a genuine recorder snapshot: either the real accepted owner, wrapper,
 * collector, ledger, adapter and session over a virtual clock, injected timers, a scripted
 * in-memory fetch and a fake `ws`-like client, or the recorder over the real wrapper alone. Every
 * write goes to a fresh temporary directory, removed afterwards. No socket, request or clock.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
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
} from "../candidate-scanner/CpmmPoolConnectionOwner.js";
import {
  CpmmPoolNotificationCollector,
  type CpmmCollectorLimits,
} from "../candidate-scanner/CpmmPoolNotificationCollector.js";
import {
  createCpmmPoolObservationRecorder,
  createExchangeObserverFanOut,
  type CpmmObservationFinishInput,
  type CpmmObservationRecorderLimits,
  type CpmmObservationSnapshot,
  type CpmmPoolObservationRecorder,
} from "../candidate-scanner/CpmmPoolObservationRecorder.js";
import {
  CpmmPoolWebSocketTransport,
  type CpmmPoolWebSocketTransportLimits,
  type CpmmWsClientConstructor,
  type CpmmWsClientEvent,
  type CpmmWsClientLike,
  type CpmmWsClientOptions,
} from "../candidate-scanner/CpmmPoolWebSocketTransport.js";
import { CpmmResolutionAccountingLedger } from "../candidate-scanner/CpmmResolutionAccountingLedger.js";
import {
  PaperRequestSession,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import {
  CANONICAL_CPMM_AUTH_BUMP,
  adaptRaydiumCpmmPoolState,
} from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import {
  CPMM_SWAP_BASE_INPUT_DISCRIMINATOR,
  CPMM_SWAP_EVENT_DISCRIMINATOR,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../candidate-scanner/RaydiumCpmmSwapDecoder.js";
import {
  RaydiumCpmmTransactionSourceAdapter,
  createCpmmExchangeEvidenceRecorder,
} from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "../candidate-scanner/RollingTradeFlowTracker.js";
import {
  CPMM_EVIDENCE_FALSE_FLAGS,
  CPMM_EVIDENCE_FILES,
  CPMM_EVIDENCE_ROOT_SEGMENTS,
  CPMM_EVIDENCE_VERIFIER_LIMITS,
  sealCpmmObservationEvidence,
  verifyCpmmObservationEvidence,
  type SealCpmmObservationInput,
} from "./cpmm-pool-observation-evidence.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const SECRET = "k3yS3cr3tEvdAbCd1234";
const HOST = "rpc.example.test";
const ENDPOINT = `wss://${HOST}/ws?api-key=${SECRET}`;
const RPC_URL = `https://${HOST}/?api-key=${SECRET}`;
const CREDENTIALS = { urls: [RPC_URL, ENDPOINT], additional: [SECRET] };
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
const LEDGER_LIMITS = { maxSignatureRecords: 16, maxDuplicateDetailsPerRecord: 4, maxEpochs: 4 };
const ADAPTER_LIMITS = { maxTrackedSignatures: 32, maxResponseBytes: 100_000 };
const LANES = {
  SOLANA_RPC: { maxAttempts: 40, pacingMs: 2_500, maxResponseBytes: 200_000 },
  RUGCHECK: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
  SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
  DEXSCREENER: { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 },
};
const VERSIONS = {
  owner: "446eec4",
  wrapper: "87b50b3",
  collector: "1111111",
  ledger: "2222222",
  adapter: "2fd2f16",
  decoder: "3333333",
  session: "4444444",
  recorder: "5de691f",
  sanitizer: "573738f",
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

const TMP = mkdtempSync(path.join(tmpdir(), "cpmm-evidence-test-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
let dirCounter = 0;
const freshRoot = () => {
  const d = path.join(TMP, `root-${++dirCounter}`);
  mkdirSync(d);
  return d;
};

// --- fake ws-like client ------------------------------------------------------------------------

type Cb = (err?: unknown) => void;
interface Script {
  autoPong?: boolean;
  /** none: close() never closes (the socket stays open until terminated). */
  closeMode?: "sync" | "none";
}
class FakeClient implements CpmmWsClientLike {
  public readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
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
  send(_data: string, cb: Cb): void {
    queueMicrotask(() => cb());
  }
  ping(data: Uint8Array, _mask: boolean, cb: Cb): void {
    queueMicrotask(() => cb());
    if (this.s.autoPong) {
      const echo = Buffer.from(data);
      queueMicrotask(() => this.emit("pong", echo));
    }
  }
  pong(_data: Uint8Array, _mask: boolean, cb: Cb): void {
    queueMicrotask(() => cb());
  }
  close(): void {
    if (this.s.closeMode === "none") return;
    this.#rs = 3;
    this.emit("close", 1000, Buffer.from("bye"));
  }
  terminate(): void {
    this.#rs = 2;
  }
  open(): void {
    this.#rs = 1;
    this.emit("open");
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

// --- pool, transactions and frames ---------------------------------------------------------------

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

function poolFixture() {
  const vault = (mint: string, raw: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58: mint,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount: raw,
      state: 1,
    });
  const poolAccount = {
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
  };
  const vault0Account = {
    address: FIXTURE_CPMM_TOKEN_0_VAULT,
    data: vault(CANDIDATE, 10_000_000_000n),
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: 300_000_000,
  };
  const vault1Account = {
    address: FIXTURE_CPMM_TOKEN_1_VAULT,
    data: vault(WSOL_MINT, 50_000_000_000n),
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: 300_000_000,
  };
  const target = { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE };
  const r = adaptRaydiumCpmmPoolState({ target, poolAccount, vault0Account, vault1Account });
  if (!r.ok) throw new Error(`fixture refused: ${r.refusalCode}`);
  return { target, poolAccount, vault0Account, vault1Account, adapted: r };
}
const FIXTURE = poolFixture();
const POOL = FIXTURE.adapted;

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
const notif = (n: number, logs: string[] = ["Program log: swap"]) =>
  enc({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: SUB,
      result: {
        context: { slot: SLOT },
        value: { signature: signatureOf(n), err: null, logs },
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

// --- integration harness --------------------------------------------------------------------------

function env(
  limits: Partial<CpmmObservationRecorderLimits> = {},
  collectorLimits: Partial<CpmmCollectorLimits> = {},
  transport: {
    closeMode?: "sync" | "none" | undefined;
    wrapTransport?: ((t: CpmmOwnerTransport) => CpmmOwnerTransport) | undefined;
  } = {},
) {
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
  const recorderLimits = { ...RLIMITS, ...limits };
  const recorder = createCpmmPoolObservationRecorder({ limits: recorderLimits });
  const fanOut = createExchangeObserverFanOut({
    observers: [
      { label: "adapter-evidence", observe: (ev) => evidence.observe(ev) },
      { label: "observation-recorder", observe: (ev) => recorder.observeExchange(ev) },
    ],
    maxRetainedFailures: 8,
  });
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    limits: { lifetimeMs: 600_000, maxHttpAttempts: 40, requestTimeoutMs: 10_000, lanes: LANES },
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
    ...ADAPTER_LIMITS,
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
    limits: LEDGER_LIMITS,
  });
  const collector = new CpmmPoolNotificationCollector({
    binding: adapter.getBinding(),
    limits: { ...COLLECTOR_LIMITS, ...collectorLimits },
    commitment: "confirmed",
  });
  const f = fakeCtor({ autoPong: true, closeMode: transport.closeMode ?? "sync" });
  const wrappers: CpmmPoolWebSocketTransport[] = [];
  const owner = new CpmmPoolConnectionOwner({
    session,
    collector,
    ledger: recorder.recordLedger(ledger),
    binding: adapter.getBinding(),
    transportFactory: (): CpmmOwnerTransport => {
      const w = new CpmmPoolWebSocketTransport({
        endpoint: ENDPOINT,
        clientConstructor: f.ctor,
        limits: WS_LIMITS,
      });
      wrappers.push(w);
      return recorder.recordTransport(transport.wrapTransport ? transport.wrapTransport(w) : w);
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
  const finish = (report: CpmmConnectionRunReport): CpmmObservationSnapshot =>
    recorder.finish({
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
    owner,
    recorder,
    recorderLimits,
    script,
    to,
    finish,
    binding: adapter.getBinding(),
    get c(): FakeClient {
      return f.instances[0]!;
    },
  };
}

/** A clean run: one resolved notification, a duplicate, a ping, a normal end. */
async function genuineRun(
  o: {
    limits?: Partial<CpmmObservationRecorderLimits>;
    collectorLimits?: Partial<CpmmCollectorLimits>;
    responder?: Responder;
    /** Logs of both notifications (for credential-bearing frames). */
    logs?: string[];
    pingPayload?: Buffer;
    closeMode?: "sync" | "none";
    /** Delivered right after the unsubscribe acknowledgement (after intake, before cleanup). */
    afterIntake?: Buffer;
    wrapTransport?: (t: CpmmOwnerTransport) => CpmmOwnerTransport;
    /** The unsubscribe acknowledgement never arrives (intake ends at its deadline). */
    noUnsubscribeAck?: boolean;
  } = {},
) {
  const e = env(o.limits, o.collectorLimits, {
    closeMode: o.closeMode,
    wrapTransport: o.wrapTransport,
  });
  const p = e.owner.run();
  e.c.open();
  await e.to(OBS_START + 10);
  e.c.message(ackFrame());
  await flush();
  await e.to(RECEIVED_AT);
  e.script.push(o.responder ?? okTx(1));
  e.c.message(notif(1, o.logs));
  await flush();
  await e.to(RECEIVED_AT + 3_000);
  e.c.message(notif(1, o.logs));
  e.c.emit("ping", o.pingPayload ?? Buffer.from([9, 9]));
  await flush();
  await e.to(NOMINAL_END);
  if (!o.noUnsubscribeAck) e.c.message(unsubAck());
  await flush();
  if (o.afterIntake) e.c.message(o.afterIntake);
  await e.to(
    NOMINAL_END +
      (o.closeMode === "none" ? OWNER_LIMITS.cleanupTimeoutMs : 0) +
      (o.noUnsubscribeAck ? OWNER_LIMITS.unsubscribeAckTimeoutMs : 0) +
      10,
  );
  const report = await p;
  return {
    snapshot: e.finish(report),
    recorder: e.recorder,
    e,
    report,
    recorderLimits: e.recorderLimits,
    collectorLimits: { ...COLLECTOR_LIMITS, ...o.collectorLimits },
  };
}

function plan(
  recorderLimits: CpmmObservationRecorderLimits = RLIMITS,
  collectorLimits: CpmmCollectorLimits = COLLECTOR_LIMITS,
) {
  return {
    kinds: {
      owner: "CPMM_POOL_CONNECTION_OWNER",
      wrapper: "CPMM_POOL_WEBSOCKET_TRANSPORT",
      recorder: "CPMM_POOL_OBSERVATION_RECORDER",
    },
    limits: {
      owner: { ...OWNER_LIMITS },
      wrapper: { ...WS_LIMITS },
      collector: { ...collectorLimits },
      ledger: { ...LEDGER_LIMITS },
      adapter: { ...ADAPTER_LIMITS },
      sessionLanes: JSON.parse(JSON.stringify(LANES)) as unknown,
      recorder: { ...recorderLimits },
    },
    binding: { poolAddress: POOL.poolAddress, candidateMint: POOL.candidateMint },
    epoch: 1,
    subscribeRequestId: SUB_REQ,
    unsubscribeRequestId: UNSUB_REQ,
    endpointLabels: { rpc: "SOLANA_RPC_HTTP", stream: "SOLANA_RPC_WEBSOCKET" },
  };
}

function poolContext() {
  return {
    target: { ...FIXTURE.target },
    poolAccount: { ...FIXTURE.poolAccount },
    vault0Account: { ...FIXTURE.vault0Account },
    vault1Account: { ...FIXTURE.vault1Account },
    adaptedPool: FIXTURE.adapted,
    acquisition: "SUPPLIED_UNVERIFIED" as const,
  };
}

function sealInput(
  snapshot: CpmmObservationSnapshot,
  recorder: CpmmPoolObservationRecorder | null,
  over: Partial<SealCpmmObservationInput> = {},
  recorderLimits: CpmmObservationRecorderLimits = RLIMITS,
  collectorLimits: CpmmCollectorLimits = COLLECTOR_LIMITS,
): SealCpmmObservationInput {
  return {
    projectRoot: freshRoot(),
    runId: "run-1",
    snapshot,
    plan: plan(recorderLimits, collectorLimits),
    componentVersions: { ...VERSIONS },
    poolContext: poolContext(),
    credentials: { urls: [...CREDENTIALS.urls], additional: [...CREDENTIALS.additional] },
    lateActivity: recorder === null ? null : { ...recorder.lateActivity() },
    ...over,
  };
}

const NOT_ATTEMPTED = { status: "NOT_ATTEMPTED", implementedComponents: null, components: null };

/** Pool context and collector reproduced; everything else explicitly not implemented. */
function expectReproduced(v: ReturnType<typeof verifyCpmmObservationEvidence>): void {
  expect(v.rederivation).toMatchObject({
    status: "PARTIAL",
    implementedComponents: "REPRODUCED",
    components: {
      poolContext: { status: "REPRODUCED", findings: [] },
      collector: {
        status: "REPRODUCED",
        findings: [],
        structurallyCheckedFrames: 0,
        epochReportCompared: true,
        countersCompared: true,
      },
      transactionAnalysis: { status: "NOT_IMPLEMENTED" },
      ledger: { status: "NOT_IMPLEMENTED" },
      ownerWrapperCrossChecks: { status: "NOT_IMPLEMENTED" },
      runtimeAccounting: { status: "RUNTIME_ACCOUNTING_NOT_REPRODUCED" },
    },
  });
  expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
  expect(v.acquisitionProvenance).toBe("OPEN_G3");
  expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
}

const outDirOf = (root: string, runId = "run-1") =>
  path.join(root, ...CPMM_EVIDENCE_ROOT_SEGMENTS, runId);

function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listAll(abs).map((x) => `${name}/${x}`));
    else out.push(name);
  }
  return out.sort();
}

function expectNoCredential(dir: string): void {
  for (const f of listAll(dir)) {
    const text = readFileSync(path.join(dir, ...f.split("/")), "utf8");
    expect(text.includes(SECRET), f).toBe(false);
    expect(text.includes("https://"), f).toBe(false);
    expect(text.includes("wss://"), f).toBe(false);
  }
}

const readJson = (dir: string, rel: string) =>
  JSON.parse(readFileSync(path.join(dir, ...rel.split("/")), "utf8")) as Record<string, unknown>;

/** Rewrites one file and re-digests the report and the manifest consistently. */
function reseal(dir: string, rel: string, mutate: (doc: Record<string, unknown>) => void): void {
  const write = (r: string, doc: unknown) =>
    writeFileSync(path.join(dir, ...r.split("/")), `${JSON.stringify(doc, null, 2)}\n`);
  const digestOf = (r: string) => {
    const b = readFileSync(path.join(dir, ...r.split("/")));
    return { path: r, bytes: b.length, sha256: sha(b) };
  };
  const doc = readJson(dir, rel);
  mutate(doc);
  write(rel, doc);
  if (rel !== CPMM_EVIDENCE_FILES.report && rel !== CPMM_EVIDENCE_FILES.manifest) {
    const report = readJson(dir, CPMM_EVIDENCE_FILES.report);
    report.files = (report.files as { path: string }[]).map((f) =>
      f.path === rel ? digestOf(rel) : f,
    );
    write(CPMM_EVIDENCE_FILES.report, report);
  }
  if (rel !== CPMM_EVIDENCE_FILES.manifest) {
    const manifest = readJson(dir, CPMM_EVIDENCE_FILES.manifest);
    manifest.files = (manifest.files as { path: string }[]).map((f) =>
      f.path === rel || f.path === CPMM_EVIDENCE_FILES.report ? digestOf(f.path) : f,
    );
    write(CPMM_EVIDENCE_FILES.manifest, manifest);
  }
}

/** A sealed copy to tamper with. */
function copyOf(dir: string): string {
  const d = path.join(TMP, `copy-${++dirCounter}`);
  cpSync(dir, d, { recursive: true });
  return d;
}

// --- the recorder over the real wrapper alone ------------------------------------------------------

function wrapperOnly(limits: Partial<CpmmObservationRecorderLimits> = {}) {
  const f = fakeCtor({});
  const w = new CpmmPoolWebSocketTransport({
    endpoint: ENDPOINT,
    clientConstructor: f.ctor,
    limits: WS_LIMITS,
  });
  const recorderLimits = { ...RLIMITS, ...limits };
  const r = createCpmmPoolObservationRecorder({ limits: recorderLimits });
  const t = r.recordTransport(w);
  t.start();
  f.instances[0]!.open();
  return { r, t, c: f.instances[0]!, recorderLimits };
}
const NO_COMPONENTS: CpmmObservationFinishInput = {
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

// The genuine clean run, sealed once and shared by the tampering tests.
const shared = (async () => {
  const run = await genuineRun();
  const input = sealInput(run.snapshot, run.recorder);
  const result = sealCpmmObservationEvidence(input);
  if (!result.ok) throw new Error(`fixture seal failed: ${result.code}`);
  return { run, input, result, dir: result.outDir };
})();

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM observation evidence: sealing", () => {
  it("E1: a genuine clean run seals exclusively, manifest last, and verifies with complete retention", async () => {
    const run = await genuineRun();
    const order: string[] = [];
    const flags: string[] = [];
    const input = sealInput(run.snapshot, run.recorder, {
      writeEvidenceFile: (abs, content, options) => {
        order.push(abs);
        flags.push(options.flag);
        writeFileSync(abs, content, options);
      },
    });
    const planBefore = JSON.stringify(input.plan);
    const result = sealCpmmObservationEvidence(input);
    expect(result).toMatchObject({ ok: true, status: "SEALED", rederivation: "NOT_IMPLEMENTED" });
    if (!result.ok) return;
    expect(result.outDir).toBe(outDirOf(input.projectRoot));
    expect(path.basename(order[order.length - 1]!)).toBe(CPMM_EVIDENCE_FILES.manifest);
    expect(new Set(flags)).toEqual(new Set(["wx"]));
    expect(order.length).toBe(result.files.length + 1);
    // Exactly the listed files, plus the manifest.
    expect(listAll(result.outDir)).toEqual(
      [...result.files.map((f) => f.path), CPMM_EVIDENCE_FILES.manifest].sort(),
    );
    expect(sha(readFileSync(path.join(result.outDir, CPMM_EVIDENCE_FILES.manifest)))).toBe(
      result.manifestSha256,
    );
    const v = verifyCpmmObservationEvidence(result.outDir);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.retention).toEqual({ status: "COMPLETE", reasons: [] });
    expectReproduced(v);
    expect(v.sealedClaims).toMatchObject({ rederivation: { status: "NOT_IMPLEMENTED" } });
    expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
    expect(v.acquisitionProvenance).toBe("OPEN_G3");
    expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(v.manifestSha256).toBe(result.manifestSha256);
    // Content: one exchange, bound to the session window; original and stored digests kept.
    const index = readJson(result.outDir, CPMM_EVIDENCE_FILES.exchangeIndex);
    const [x] = index.exchanges as { seq: number; path: string }[];
    expect((index.exchanges as unknown[]).length).toBe(1);
    const exchange = readJson(result.outDir, x!.path);
    expect(exchange).toMatchObject({
      endpoint: "SESSION_RPC_ENDPOINT_NOT_RETAINED",
      bodyState: "COMPLETE",
    });
    expect(exchange.body).toMatchObject({ storedEncoding: "utf8", payloadRedacted: false });
    const body = exchange.body as { stored: string; storedSha256: string; originalSha256: string };
    expect(sha(Buffer.from(body.stored))).toBe(body.storedSha256);
    expect(body.storedSha256).toBe(body.originalSha256);
    const report = readJson(result.outDir, CPMM_EVIDENCE_FILES.report);
    expect(report).toMatchObject({
      ...CPMM_EVIDENCE_FALSE_FLAGS,
      rederivation: { status: "NOT_IMPLEMENTED" },
      poolContextProvenance: "SUPPLIED_UNVERIFIED",
      credentialsRecorded: false,
      endpointUrlsRecorded: false,
      runOutcome: { connectionRunClean: true, cleanupStatus: "SETTLED" },
    });
    const pool = readJson(result.outDir, CPMM_EVIDENCE_FILES.poolContext);
    expect(pool).toMatchObject({
      acquisition: "SUPPLIED_UNVERIFIED",
      adaptedPool: { baseVaultRaw: { $bigint: "10000000000" } },
    });
    expect(get(pool, "accounts", "pool", "data")).toMatchObject({
      originalSha256: sha(FIXTURE.poolAccount.data),
      storedEncoding: "base64",
    });
    expectNoCredential(result.outDir);
    // Caller objects untouched and never frozen.
    expect(JSON.stringify(input.plan)).toBe(planBefore);
    expect(Object.isFrozen(input.plan)).toBe(false);
    expect(Object.isFrozen(input.poolContext)).toBe(false);
    expect(Object.isFrozen(input.credentials.urls)).toBe(false);
  });

  it("E2: retention pressure seals with integrity, and retention is derived as incomplete with reasons", async () => {
    const limits = { maxIncomingRecords: 2, maxOutgoingPayloadBytes: 10 };
    const run = await genuineRun({ limits });
    expect(run.snapshot.retention.recorderRetentionComplete).toBe(false);
    const recorderLimits = { ...RLIMITS, ...limits };
    const result = sealCpmmObservationEvidence(
      sealInput(run.snapshot, run.recorder, {}, recorderLimits),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = verifyCpmmObservationEvidence(result.outDir);
    expect(v.integrity.ok).toBe(true);
    expect(v.retention.status).toBe("INCOMPLETE");
    expect(v.retention.reasons).toEqual(
      expect.arrayContaining([
        "PAYLOAD_OMITTED:transport-records.json",
        "RECORDS_DROPPED:incoming",
      ]),
    );
    const records = readJson(result.outDir, CPMM_EVIDENCE_FILES.transportRecords).records as {
      payload?: { payloadOmitted: string | null; originalSha256: string | null };
    }[];
    const omitted = records.filter((r) => r.payload?.payloadOmitted === "BYTE_ALLOWANCE");
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((r) => /^[0-9a-f]{64}$/.test(r.payload!.originalSha256!))).toBe(true);
  });

  it("E3: credentials in structured, binary and control payloads are redacted on bytes; scans withhold; files hold no credential", async () => {
    const m = wrapperOnly();
    m.c.message(Buffer.from(JSON.stringify({ [SECRET]: `value ${SECRET} end`, ok: 1 })));
    m.c.message(
      Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(SECRET), Buffer.from([0x80])]),
    );
    m.c.emit("ping", Buffer.from(`p:${SECRET}`));
    m.c.message(Buffer.from(`see ${RPC_URL.slice(0, 12)}`)); // a URL prefix: detected, withheld
    m.c.message(Buffer.from("x%252525252541y")); // decoding never settles: inconclusive, withheld
    m.c.message(Buffer.from('{"clean":true}'));
    await flush();
    const snapshot = m.r.finish(NO_COMPONENTS);
    const result = sealCpmmObservationEvidence(sealInput(snapshot, m.r, {}, m.recorderLimits));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payloads).toMatchObject({ redacted: 3, withheld: 2 });
    const records = readJson(result.outDir, CPMM_EVIDENCE_FILES.transportRecords).records as {
      kind: string;
      event?: string;
      payload?: Record<string, unknown>;
    }[];
    const payloads = records.filter((r) => r.kind === "EVENT" && r.payload).map((r) => r.payload!);
    const [structured, binary, ping, url, nested, clean] = payloads;
    expect(structured).toMatchObject({
      storedEncoding: "utf8",
      payloadRedacted: true,
      withheldReason: null,
    });
    expect(structured!.stored).toBe(
      JSON.stringify({ "[REDACTED]": "value [REDACTED] end", ok: 1 }),
    );
    expect(structured!.originalSha256).not.toBe(structured!.storedSha256);
    expect(binary).toMatchObject({ storedEncoding: "base64", payloadRedacted: true });
    const binaryBytes = Buffer.from(binary!.stored as string, "base64");
    expect(binaryBytes.includes(Buffer.from(SECRET))).toBe(false);
    expect(sha(binaryBytes)).toBe(binary!.storedSha256);
    expect(ping).toMatchObject({ payloadRedacted: true, stored: "p:[REDACTED]" });
    expect(url).toMatchObject({ withheldReason: "CREDENTIAL_MATERIAL_DETECTED", stored: null });
    expect(nested).toMatchObject({ withheldReason: "CREDENTIAL_SCAN_INCONCLUSIVE", stored: null });
    expect(clean).toMatchObject({ payloadRedacted: false, stored: '{"clean":true}' });
    expectNoCredential(result.outDir);
    const v = verifyCpmmObservationEvidence(result.outDir);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.retention.status).toBe("INCOMPLETE");
    expect(v.retention.reasons).toEqual(
      expect.arrayContaining([
        "PAYLOAD_WITHHELD:transport-records.json",
        "COMPONENT_UNAVAILABLE:report",
        "LEDGER_NOT_RECORDED",
      ]),
    );
  });

  it("E3b: a credential in a structured response body is redacted, and the exchange still binds to the session ledger", async () => {
    const run = await genuineRun({
      responder: async ({ id }) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id, result: null, [SECRET]: SECRET }), {
          status: 200,
        }),
    });
    const result = sealCpmmObservationEvidence(sealInput(run.snapshot, run.recorder));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [x] = readJson(result.outDir, CPMM_EVIDENCE_FILES.exchangeIndex).exchanges as {
      path: string;
    }[];
    const body = readJson(result.outDir, x!.path).body as Record<string, unknown>;
    expect(body).toMatchObject({ payloadRedacted: true, jsonInspection: "INSPECTED" });
    expect(String(body.stored)).toContain('"[REDACTED]":"[REDACTED]"');
    expect(body.originalSha256).not.toBe(body.storedSha256);
    expectNoCredential(result.outDir);
    expect(verifyCpmmObservationEvidence(result.outDir).integrity.ok).toBe(true);
  });

  it("E4: a residual credential anywhere in a rendered file refuses the seal before any directory exists", async () => {
    const { run } = await shared;
    const escaped = SECRET.replace("S", "\\u0053");
    for (const leak of [SECRET, escaped, encodeURIComponent(`${SECRET}/`).replace("S", "%53")]) {
      const context = poolContext();
      const input = sealInput(run.snapshot, run.recorder, {
        poolContext: { ...context, adaptedPool: { ...FIXTURE.adapted, lpMint: leak } },
      });
      const r = sealCpmmObservationEvidence(input);
      expect(r).toMatchObject({
        ok: false,
        status: "SEAL_REFUSED",
        code: "RESIDUAL_CREDENTIAL:pool-context.json",
        outDir: null,
        filesWritten: [],
      });
      expect(existsSync(path.join(input.projectRoot, "data"))).toBe(false);
      expect(JSON.stringify(r).includes(SECRET)).toBe(false);
    }
  });

  it("E5: inputs are validated without running getters or proxies, and never frozen", async () => {
    const { run } = await shared;
    let getterRuns = 0;
    const withGetter = plan();
    Object.defineProperty(withGetter, "epoch", {
      get: () => {
        getterRuns++;
        return 1;
      },
      enumerable: true,
    });
    const nestedGetter = Object.defineProperty({ candidateMint: CANDIDATE }, "poolAddress", {
      get: () => {
        getterRuns++;
        return POOL.poolAddress;
      },
      enumerable: true,
    });
    const cases: [Partial<SealCpmmObservationInput>, string][] = [
      [{ plan: withGetter as never }, "PLAN_ACCESSOR"],
      [{ plan: { ...plan(), binding: nestedGetter } }, "INPUT_ACCESSOR"],
      [{ plan: new Proxy(plan(), {}) as never }, "PLAN_NOT_PLAIN_OBJECT"],
      [{ snapshot: { ...run.snapshot, kind: "OTHER" } as never }, "SNAPSHOT_KIND_INVALID"],
      [{ snapshot: new Proxy(run.snapshot, {}) }, "INPUT_PROXY"],
      [{ plan: plan({ ...RLIMITS, maxIncomingRecords: 1 }) }, "RECORDER_LIMITS_MISMATCH"],
      [{ componentVersions: { ...VERSIONS, owner: "main" } }, "COMPONENT_VERSIONS_INVALID"],
      [
        { poolContext: { ...poolContext(), acquisition: "ACQUIRED" as never } },
        "POOL_CONTEXT_ACQUISITION_UNSUPPORTED",
      ],
      [{ plan: { ...plan(), endpointLabels: { rpc: RPC_URL } } }, "PLAN_ENDPOINT_LABELS_INVALID"],
      [{ runId: "../escape" }, "RUN_ID_INVALID"],
      [{ projectRoot: "relative/root" }, "PROJECT_ROOT_INVALID"],
      [{ credentials: { urls: [], additional: [] } }, "CREDENTIALS_INVALID"],
      [{ credentials: { urls: [RPC_URL], additional: ["abc"] } }, "CREDENTIALS_INVALID"],
      [
        {
          poolContext: {
            ...poolContext(),
            poolAccount: { ...FIXTURE.poolAccount, data: [1] as never },
          },
        },
        "POOL_ACCOUNT_DATA_INVALID",
      ],
      [{ lateActivity: { completions: -1 } }, "LATE_ACTIVITY_INVALID"],
    ];
    for (const [over, code] of cases) {
      const input = sealInput(run.snapshot, run.recorder, over);
      const r = sealCpmmObservationEvidence(input);
      expect(r, code).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID", code });
      expect(existsSync(path.join(input.projectRoot, "data")), code).toBe(false);
    }
    expect(getterRuns).toBe(0);
    // A payload in the snapshot that contradicts its own digest is refused.
    const tampered = JSON.parse(JSON.stringify(run.snapshot)) as CpmmObservationSnapshot;
    (tampered.incoming[0]!.payload as { sha256: string }).sha256 = "0".repeat(64);
    expect(sealCpmmObservationEvidence(sealInput(tampered, run.recorder))).toMatchObject({
      status: "SEAL_INPUT_INVALID",
      code: "SNAPSHOT_PAYLOAD_INCONSISTENT",
    });
    expect(Object.isFrozen(tampered)).toBe(false);
  });

  it("E6: an existing directory is refused and left untouched", async () => {
    const { input, dir } = await shared;
    const before = listAll(dir).map((f) => [f, sha(readFileSync(path.join(dir, ...f.split("/"))))]);
    const again = sealCpmmObservationEvidence({ ...input });
    expect(again).toMatchObject({
      ok: false,
      status: "OUTPUT_DIRECTORY_UNAVAILABLE",
      code: "OUTPUT_DIRECTORY_EXISTS",
      filesWritten: [],
    });
    expect(
      listAll(dir).map((f) => [f, sha(readFileSync(path.join(dir, ...f.split("/"))))]),
    ).toEqual(before);
    expect(verifyCpmmObservationEvidence(dir).integrity.ok).toBe(true);
  });

  it("E7: a partial write failure reports what was created, leaves no manifest, and is never retried", async () => {
    const { run } = await shared;
    let calls = 0;
    const input = sealInput(run.snapshot, run.recorder, {
      writeEvidenceFile: (abs, content, options) => {
        calls++;
        if (calls === 4) {
          const e = new Error(`disk failure at ${abs} ${SECRET}`) as Error & { code: string };
          e.code = "EIO";
          throw e;
        }
        writeFileSync(abs, content, options);
      },
    });
    const r = sealCpmmObservationEvidence(input);
    expect(r).toMatchObject({
      ok: false,
      status: "ARTIFACT_WRITE_FAILED",
      code: "ARTIFACT_WRITE_FAILED:EIO",
      failedFile: CPMM_EVIDENCE_FILES.transportDiagnostics,
      filesWritten: [
        CPMM_EVIDENCE_FILES.plan,
        CPMM_EVIDENCE_FILES.poolContext,
        CPMM_EVIDENCE_FILES.ownerReport,
      ],
      directoriesCreated: [],
    });
    expect(calls).toBe(4);
    expect(JSON.stringify(r).includes(SECRET)).toBe(false);
    const outDir = outDirOf(input.projectRoot);
    expect(existsSync(path.join(outDir, CPMM_EVIDENCE_FILES.manifest))).toBe(false);
    expect(verifyCpmmObservationEvidence(outDir).integrity.problems).toEqual(["MANIFEST_MISSING"]);
    // A failure after the exchanges directory exists reports it too.
    let n = 0;
    const late = sealInput(run.snapshot, run.recorder, {
      writeEvidenceFile: (abs, content, options) => {
        if (++n === 10) throw Object.assign(new Error("x"), { code: "ENOSPC" });
        writeFileSync(abs, content, options);
      },
    });
    expect(sealCpmmObservationEvidence(late)).toMatchObject({
      status: "ARTIFACT_WRITE_FAILED",
      code: "ARTIFACT_WRITE_FAILED:ENOSPC",
      directoriesCreated: ["exchanges"],
    });
  });
});

describe("CPMM observation evidence: verification", () => {
  const problemsOf = (dir: string) => verifyCpmmObservationEvidence(dir).integrity.problems;

  it("V1: byte, size, missing, unlisted and directory tampering fail integrity and stop processing", async () => {
    const { dir } = await shared;
    const a = copyOf(dir);
    const file = path.join(a, CPMM_EVIDENCE_FILES.collector);
    const bytes = readFileSync(file);
    bytes[10] = bytes[10] === 0x20 ? 0x21 : 0x20;
    writeFileSync(file, bytes);
    const va = verifyCpmmObservationEvidence(a);
    expect(va.integrity.problems).toEqual(["HASH_MISMATCH:collector.json"]);
    expect(va.retention).toEqual({ status: "NOT_EVALUATED", reasons: [] });
    expect(va.rederivation).toEqual(NOT_ATTEMPTED);
    expect(va.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);

    const b = copyOf(dir);
    appendFileSync(path.join(b, CPMM_EVIDENCE_FILES.ledger), " ");
    expect(problemsOf(b)).toEqual(["SIZE_MISMATCH:ledger.json"]);

    const c = copyOf(dir);
    unlinkSync(path.join(c, CPMM_EVIDENCE_FILES.recording));
    expect(problemsOf(c)).toEqual(["MISSING_FILE:recording.json"]);

    const d = copyOf(dir);
    writeFileSync(path.join(d, "extra.json"), "{}");
    mkdirSync(path.join(d, "other"));
    mkdirSync(path.join(d, "exchanges", "nested"));
    writeFileSync(path.join(d, "exchanges", "nested", "x.json"), "{}");
    expect(problemsOf(d)).toEqual(
      expect.arrayContaining([
        "UNLISTED_FILE:extra.json",
        "UNLISTED_DIRECTORY:other",
        "UNLISTED_DIRECTORY:exchanges/nested",
      ]),
    );
  });

  it("V2: links are rejected: a junction inside, a hard-linked file, and a junction as the directory itself", async () => {
    const { dir } = await shared;
    const outside = path.join(TMP, `outside-${++dirCounter}`);
    mkdirSync(outside);
    const a = copyOf(dir);
    symlinkSync(outside, path.join(a, "linked"), "junction");
    expect(problemsOf(a)).toEqual(["LINK_REJECTED:linked"]);

    const b = copyOf(dir);
    linkSync(path.join(b, CPMM_EVIDENCE_FILES.ledger), path.join(outside, "ledger-link.json"));
    expect(problemsOf(b)).toEqual(["LINK_REJECTED:ledger.json"]);

    const c = path.join(TMP, `junction-${++dirCounter}`);
    symlinkSync(copyOf(dir), c, "junction");
    expect(problemsOf(c)).toEqual(["OUTPUT_DIRECTORY_INVALID"]);
    expect(problemsOf("relative/dir")).toEqual(["OUTPUT_DIRECTORY_INVALID"]);
    expect(problemsOf(path.join(TMP, "absent"))).toEqual(["OUTPUT_DIRECTORY_MISSING"]);
  });

  it("V3: manifest schema, versions, confinement, uniqueness, order, required files and bounds", async () => {
    const { dir } = await shared;
    const cases: [(m: Record<string, unknown>) => void, string[]][] = [
      [(m) => (m.kind = "OTHER"), ["MANIFEST_KIND_INVALID"]],
      [(m) => (m.version = 2), ["MANIFEST_VERSION_UNSUPPORTED"]],
      [(m) => (m.evidenceSchemaVersion = 9), ["EVIDENCE_SCHEMA_VERSION_UNSUPPORTED"]],
      [
        (m) => ((m.componentVersions as Record<string, string>).owner = "HEAD"),
        ["MANIFEST_COMPONENT_VERSIONS_INVALID"],
      ],
      [(m) => (m.extra = 1), ["MANIFEST_SCHEMA_INVALID"]],
      [
        (m) =>
          (m.files as { path: string }[]).push({
            path: "../outside.json",
            bytes: 1,
            sha256: "0".repeat(64),
          } as never),
        ["MANIFEST_PATH_NOT_CONFINED"],
      ],
      [
        (m) =>
          (m.files as unknown[]).push({ path: "C:/abs.json", bytes: 1, sha256: "0".repeat(64) }),
        ["MANIFEST_PATH_NOT_CONFINED"],
      ],
      [
        (m) =>
          (m.files as unknown[]).push({
            path: CPMM_EVIDENCE_FILES.manifest,
            bytes: 1,
            sha256: "0".repeat(64),
          }),
        ["MANIFEST_PATH_UNKNOWN:cpmm-observation-manifest.json"],
      ],
      [
        (m) => {
          const f = m.files as unknown[];
          f.push({ ...(f[0] as object) });
        },
        [`MANIFEST_PATH_DUPLICATE:${CPMM_EVIDENCE_FILES.collector}`],
      ],
      [(m) => (m.files as unknown[]).reverse(), ["MANIFEST_NOT_SORTED"]],
      [
        (m) =>
          (m.files = (m.files as { path: string }[]).filter(
            (f) => f.path !== CPMM_EVIDENCE_FILES.ledger,
          )),
        ["REQUIRED_FILE_NOT_LISTED:ledger.json"],
      ],
      [
        (m) =>
          ((m.files as { bytes: number }[])[0]!.bytes =
            CPMM_EVIDENCE_VERIFIER_LIMITS.maxFileBytes + 1),
        [`MANIFEST_FILE_TOO_LARGE:${CPMM_EVIDENCE_FILES.collector}`],
      ],
      [(m) => ((m.files as { sha256: string }[])[0]!.sha256 = "ABC"), ["MANIFEST_ENTRY_MALFORMED"]],
    ];
    for (const [mutate, expected] of cases) {
      const d = copyOf(dir);
      reseal(d, CPMM_EVIDENCE_FILES.manifest, mutate);
      const problems = problemsOf(d);
      for (const p of expected) expect(problems, p).toContain(p);
    }
    // Too many entries is refused before any entry is read.
    const many = copyOf(dir);
    reseal(many, CPMM_EVIDENCE_FILES.manifest, (m) => {
      m.files = Array.from({ length: CPMM_EVIDENCE_VERIFIER_LIMITS.maxEntries + 1 }, () => ({}));
    });
    expect(problemsOf(many)).toEqual(["MANIFEST_FILES_INVALID"]);
    // An oversized manifest is refused before it is read.
    const big = copyOf(dir);
    writeFileSync(
      path.join(big, CPMM_EVIDENCE_FILES.manifest),
      Buffer.alloc(CPMM_EVIDENCE_VERIFIER_LIMITS.maxManifestBytes + 1, 0x20),
    );
    expect(problemsOf(big)).toEqual(["MANIFEST_TOO_LARGE"]);
    // Invalid UTF-8 in the manifest, or in a listed file.
    const bad = copyOf(dir);
    writeFileSync(path.join(bad, CPMM_EVIDENCE_FILES.manifest), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(problemsOf(bad)).toEqual(["MANIFEST_SCHEMA_INVALID"]);
    const badFile = copyOf(dir);
    writeFileSync(
      path.join(badFile, CPMM_EVIDENCE_FILES.recording),
      Buffer.from([0x7b, 0xff, 0x7d]),
    );
    reseal(badFile, CPMM_EVIDENCE_FILES.manifest, (m) => {
      m.files = (m.files as { path: string }[]).map((f) =>
        f.path === CPMM_EVIDENCE_FILES.recording
          ? { path: f.path, bytes: 3, sha256: sha(Buffer.from([0x7b, 0xff, 0x7d])) }
          : f,
      );
    });
    expect(problemsOf(badFile)).toEqual(["FILE_NOT_JSON:recording.json"]);
  });

  it("V4: consistent rewrites are still caught: report references, claims, payload encodings and digests, ordinal order", async () => {
    const { dir } = await shared;
    const exchangeFile = (
      readJson(dir, CPMM_EVIDENCE_FILES.exchangeIndex).exchanges as { path: string }[]
    )[0]!.path;
    const firstPayloadRecord = (doc: Record<string, unknown>) =>
      (doc.records as { payload?: Record<string, unknown> }[]).find(
        (r) => r.payload && r.payload.stored !== null,
      )!.payload!;
    const cases: [string, (d: Record<string, unknown>) => void, string][] = [
      [
        CPMM_EVIDENCE_FILES.report,
        (r) => (r.admissionEligible = true),
        "REPORT_FLAG_INVALID:admissionEligible",
      ],
      [
        CPMM_EVIDENCE_FILES.report,
        (r) => (r.rederivation = { status: "REPRODUCED" }),
        "REPORT_REDERIVATION_CLAIM_INVALID",
      ],
      [
        CPMM_EVIDENCE_FILES.report,
        (r) => ((r.files as { sha256: string }[])[0]!.sha256 = "0".repeat(64)),
        "REPORT_REFERENCES_MISMATCH",
      ],
      [
        CPMM_EVIDENCE_FILES.poolContext,
        (p) => (p.acquisition = "ACQUIRED"),
        "POOL_CONTEXT_PROVENANCE_INVALID",
      ],
      [CPMM_EVIDENCE_FILES.ledger, (l) => (l.kind = "OTHER"), "FILE_KIND_INVALID:ledger.json"],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => (firstPayloadRecord(t).stored = `${String(firstPayloadRecord(t).stored)} `),
        "PAYLOAD_SIZE_MISMATCH",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => {
          const p = firstPayloadRecord(t);
          const s = String(p.stored);
          p.stored = `${s.slice(0, -1)}${s.endsWith("}") ? "]" : "}"}`;
        },
        "PAYLOAD_DIGEST_MISMATCH",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => {
          const p = firstPayloadRecord(t);
          p.storedEncoding = "base64";
          p.stored = Buffer.from(String(p.stored)).toString("base64");
        },
        "PAYLOAD_ENCODING_INVALID",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => (firstPayloadRecord(t).payloadRedacted = true),
        "PAYLOAD_REDACTION_INCONSISTENT",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => (firstPayloadRecord(t).withheldReason = "CREDENTIAL_SCAN_INCONCLUSIVE"),
        "PAYLOAD_STATE_INCONSISTENT",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => {
          const p = firstPayloadRecord(t);
          p.stored = "\ud800";
        },
        "PAYLOAD_ENCODING_INVALID",
      ],
      [
        CPMM_EVIDENCE_FILES.transportRecords,
        (t) => (t.records as unknown[]).reverse(),
        "TRANSPORT_RECORDS_NOT_IN_ORDINAL_ORDER",
      ],
      [
        CPMM_EVIDENCE_FILES.poolContext,
        (p) => {
          const data = get(p, "accounts", "vault0", "data") as Record<string, unknown>;
          data.stored = `${String(data.stored).slice(0, -4)}AAA`; // not canonical base64
        },
        "PAYLOAD_ENCODING_INVALID",
      ],
      [
        CPMM_EVIDENCE_FILES.poolContext,
        (p) => {
          // "/x==" decodes to 0xFF exactly like the canonical "/w==": only re-encoding detects it.
          const data = get(p, "accounts", "vault0", "data") as Record<string, unknown>;
          Object.assign(data, {
            stored: "/x==",
            storedBytes: 1,
            storedSha256: sha(Buffer.from([0xff])),
            originalBytes: 1,
            originalSha256: sha(Buffer.from([0xff])),
          });
        },
        "PAYLOAD_ENCODING_INVALID",
      ],
    ];
    for (const [file, mutate, expected] of cases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const problems = problemsOf(d);
      expect(
        problems.some((p) => p.startsWith(expected)),
        `${expected} in ${problems.join(",")}`,
      ).toBe(true);
    }
    // The exchange index and the session-ledger window must agree.
    const ledgerCases: [string, (d: Record<string, unknown>) => void, string][] = [
      [
        exchangeFile,
        (x) => ((x.entry as Record<string, unknown>).jsonRpcId = 999),
        "EXCHANGE_SESSION_LEDGER_MISMATCH",
      ],
      [
        CPMM_EVIDENCE_FILES.sessionLedger,
        (s) => ((s.window as { value: unknown[] }).value = []),
        "EXCHANGE_NOT_IN_SESSION_LEDGER",
      ],
      [
        CPMM_EVIDENCE_FILES.sessionLedger,
        (s) => (s.window = { status: "READ_FAILED", code: "THREW" }),
        "EXCHANGE_NOT_IN_SESSION_LEDGER",
      ],
      [CPMM_EVIDENCE_FILES.exchangeIndex, (i) => (i.exchanges = []), "EXCHANGE_FILE_NOT_INDEXED"],
      [
        exchangeFile,
        (x) => (x.endpoint = RPC_URL.replace(SECRET, "x")),
        "EXCHANGE_ENDPOINT_INVALID",
      ],
    ];
    for (const [file, mutate, expected] of ledgerCases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const problems = problemsOf(d);
      expect(
        problems.some((p) => p.startsWith(expected)),
        `${expected} in ${problems.join(",")}`,
      ).toBe(true);
    }
  });

  it("V5: retention is derived from the evidence, never from recorded completeness flags", async () => {
    const run = await genuineRun({ limits: { maxIncomingPayloadBytes: 8 } });
    const recorderLimits = { ...RLIMITS, maxIncomingPayloadBytes: 8 };
    const r = sealCpmmObservationEvidence(
      sealInput(run.snapshot, run.recorder, {}, recorderLimits),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The report's informational copy of the recorder's flags is never consulted.
    const d = copyOf(r.outDir);
    reseal(d, CPMM_EVIDENCE_FILES.report, (rep) => {
      rep.recordedByRecorder = { recorderRetentionComplete: true, instrumentationComplete: true };
    });
    const v = verifyCpmmObservationEvidence(d);
    expect(v.integrity.ok).toBe(true);
    expect(v.retention.status).toBe("INCOMPLETE");
    expect(v.retention.reasons).toContain("PAYLOAD_OMITTED:transport-records.json");
    // The recorder's own flag, rewritten against its own counts, is a contradiction.
    const f = copyOf(r.outDir);
    reseal(f, CPMM_EVIDENCE_FILES.recording, (rec) => {
      (rec.retention as Record<string, unknown>).recorderRetentionComplete = true;
    });
    expect(verifyCpmmObservationEvidence(f)).toMatchObject({
      integrity: { ok: false, problems: ["RECORDING_RETENTION_CONTRADICTORY"] },
      retention: { status: "NOT_EVALUATED" },
    });
    // Removing a CPMM request's exchange (index, file and manifest) is missing evidence.
    const { dir } = await shared;
    const e = copyOf(dir);
    const exchangeFile = (
      readJson(e, CPMM_EVIDENCE_FILES.exchangeIndex).exchanges as { path: string }[]
    )[0]!.path;
    unlinkSync(path.join(e, ...exchangeFile.split("/")));
    reseal(e, CPMM_EVIDENCE_FILES.manifest, (m) => {
      m.files = (m.files as { path: string }[]).filter((f) => f.path !== exchangeFile);
    });
    reseal(e, CPMM_EVIDENCE_FILES.report, (rep) => {
      rep.files = (rep.files as { path: string }[]).filter((f) => f.path !== exchangeFile);
    });
    reseal(e, CPMM_EVIDENCE_FILES.exchangeIndex, (i) => (i.exchanges = []));
    reseal(e, CPMM_EVIDENCE_FILES.recording, (rec) => {
      const x = (rec.retention as Record<string, Record<string, number>>).exchanges!;
      x.observed = 0;
      x.retained = 0;
    });
    const ve = verifyCpmmObservationEvidence(e);
    expect(ve.integrity).toEqual({ ok: true, problems: [] });
    expect(ve.retention.reasons).toEqual(["EXCHANGE_MISSING"]);
  });

  it("V6: source boundary: inert imports, no environment, clock, network, console or CLI", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./cpmm-pool-observation-evidence.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
      "node:util",
      "../candidate-scanner/CpmmPoolObservationRecorder.js",
      "../candidate-scanner/CpmmPoolNotificationCollector.js",
      "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js",
      "../candidate-scanner/ExactPoolHistoryEnumerator.js",
      "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js",
      "./evidence-credential-sanitizer.js",
    ]);
    for (const banned of [
      /\bprocess\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/,
      /\bconsole\b/,
      /\bfetch\b/,
      /\brequire\(/,
      /\bimport\(/,
      /node:(net|http|https|tls|dns|child_process|os|worker_threads)/,
      /\bWebSocket\b/,
      /import\.meta/,
      /\bargv\b/,
    ]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
    // The module's top level only declares; it touches nothing on import.
    expect(code).not.toMatch(/^(?:mkdirSync|writeFileSync|readFileSync|lstatSync|readdirSync)\(/m);
  });
});

function get(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

describe("Structural and retention boundaries (review of 84546f3)", () => {
  const sealed = async (o: Parameters<typeof genuineRun>[0] = {}) => {
    const run = await genuineRun(o);
    const r = sealCpmmObservationEvidence(sealInput(run.snapshot, run.recorder));
    if (!r.ok) throw new Error(`seal failed: ${r.code}`);
    return r.outDir;
  };
  const exchangeOf = (dir: string) =>
    (readJson(dir, CPMM_EVIDENCE_FILES.exchangeIndex).exchanges as { path: string }[])[0]!.path;
  const integrityFails = (dir: string, expected: string) => {
    const v = verifyCpmmObservationEvidence(dir);
    expect(v.integrity.ok, expected).toBe(false);
    expect(v.integrity.problems, expected).toContain(expected);
    expect(v.retention, expected).toEqual({ status: "NOT_EVALUATED", reasons: [] });
    expect(v.rederivation, expected).toEqual(NOT_ATTEMPTED);
  };

  it("N1: faithfully recorded partial and unread response bodies pass integrity, and retention says what is missing", async () => {
    const cases: [Responder, string, string][] = [
      [
        async () => new Response("x".repeat(200_001), { status: 200 }),
        "PARTIAL_OVERFLOW",
        "EXCHANGE_BODY_PARTIAL",
      ],
      [
        async () => {
          throw new Error("transport failure");
        },
        "NOT_READ",
        "EXCHANGE_BODY_NOT_READ",
      ],
    ];
    for (const [responder, state, reason] of cases) {
      const dir = await sealed({ responder });
      const ex = readJson(dir, exchangeOf(dir));
      expect(ex.bodyState).toBe(state);
      expect(get(ex, "entry", "bodyComplete")).toBe(false);
      if (state === "NOT_READ") {
        expect(ex.body).toBeNull();
        expect(ex.observedBodyBytes).toBeNull();
      } else {
        expect(ex.body).toMatchObject({ payloadOmitted: null, withheldReason: null });
        expect(ex.observedBodyBytes as number).toBeGreaterThan(
          get(ex, "body", "originalBytes") as number,
        );
      }
      const v = verifyCpmmObservationEvidence(dir);
      expect(v.integrity).toEqual({ ok: true, problems: [] });
      expect(v.retention.status).toBe("INCOMPLETE");
      expect(v.retention.reasons).toContain(reason);
      expectReproduced(v);
      expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    }
  });

  it("N2: collector retention comes from its arrays and counts; a completeness flag cannot override drops", async () => {
    const cases: [Partial<CpmmCollectorLimits>, string, string][] = [
      [
        { maxRetainedFrameRecords: 1 },
        "COLLECTOR_FRAME_RECORDS_DROPPED",
        "COLLECTOR_FRAME_COUNT_INCONSISTENT",
      ],
      [
        { maxRetainedNotifications: 1 },
        "COLLECTOR_NOTIFICATION_RECORDS_DROPPED",
        "COLLECTOR_NOTIFICATION_COUNT_INCONSISTENT",
      ],
    ];
    const mrOf = (doc: Record<string, unknown>, section: string) =>
      get(doc, section, "value", "metadataRetention") as Record<string, unknown>;
    for (const [collectorLimits, reason, countProblem] of cases) {
      const dir = await sealed({ collectorLimits });
      const v = verifyCpmmObservationEvidence(dir);
      expect(v.integrity).toEqual({ ok: true, problems: [] });
      expect(v.retention.reasons).toContain(reason);
      // Only the epoch report's flag rewritten (the review's reproduction): a contradiction.
      const a = copyOf(dir);
      reseal(a, CPMM_EVIDENCE_FILES.collector, (c) => (mrOf(c, "epochReport").complete = true));
      integrityFails(a, "COLLECTOR_RETENTION_CONTRADICTORY:epochReport");
      const b = copyOf(dir);
      reseal(b, CPMM_EVIDENCE_FILES.collector, (c) => (mrOf(c, "counters").complete = true));
      integrityFails(b, "COLLECTOR_RETENTION_CONTRADICTORY:counters");
      // The epoch report rewritten consistently still cannot hide the collector's own drops.
      const c = copyOf(dir);
      reseal(c, CPMM_EVIDENCE_FILES.collector, (doc) => {
        Object.assign(mrOf(doc, "epochReport"), {
          frameRecordsDropped: 0,
          notificationRecordsDropped: 0,
          complete: true,
        });
      });
      const vc = verifyCpmmObservationEvidence(c);
      expect(vc.integrity).toEqual({ ok: true, problems: [] });
      expect(vc.retention.reasons).toContain(reason);
      // Both rewritten consistently: the frame and notification totals no longer add up.
      const d = copyOf(dir);
      reseal(d, CPMM_EVIDENCE_FILES.collector, (doc) => {
        for (const s of ["epochReport", "counters"]) {
          Object.assign(mrOf(doc, s), {
            frameRecordsDropped: 0,
            notificationRecordsDropped: 0,
            complete: true,
          });
        }
      });
      integrityFails(d, countProblem);
    }
    // Retained counts must equal the arrays actually sealed; the epoch never exceeds the collector.
    const { dir } = await shared;
    const arrays: [(c: Record<string, unknown>) => void, string][] = [
      [
        (c) => (get(c, "frameRecords", "value") as unknown[]).pop(),
        "COLLECTOR_FRAME_RECORDS_INCONSISTENT",
      ],
      [
        (c) => (get(c, "notifications", "value") as unknown[]).pop(),
        "COLLECTOR_NOTIFICATIONS_INCONSISTENT",
      ],
      [
        (c) => {
          const mr = mrOf(c, "epochReport");
          mr.frameRecordsRetained = (mr.frameRecordsRetained as number) + 1;
        },
        "COLLECTOR_RETENTION_INCONSISTENT",
      ],
    ];
    for (const [mutate, expected] of arrays) {
      const d = copyOf(dir);
      reseal(d, CPMM_EVIDENCE_FILES.collector, mutate);
      integrityFails(d, expected);
    }
  });

  it("N3: missing payloads and malformed required structures fail integrity and stop evaluation", async () => {
    const { dir } = await shared;
    const exchange = exchangeOf(dir);
    const record = (t: Record<string, unknown>, pick: (r: Record<string, unknown>) => boolean) =>
      (t.records as Record<string, unknown>[]).find(pick)!;
    const isMessage = (r: Record<string, unknown>) => r.kind === "EVENT" && r.event === "message";
    const TR = CPMM_EVIDENCE_FILES.transportRecords;
    const COL = CPMM_EVIDENCE_FILES.collector;
    const REC = CPMM_EVIDENCE_FILES.recording;
    const cases: [string, (d: Record<string, unknown>) => void, string][] = [
      [exchange, (x) => (x.body = null), "EXCHANGE_BODY_MISSING"],
      [exchange, (x) => (x.requestBody = null), "EXCHANGE_REQUEST_BODY_INCONSISTENT"],
      [exchange, (x) => (x.method = "PUT"), "EXCHANGE_METHOD_INVALID"],
      [exchange, (x) => (x.bodyState = "UNRECOGNIZED"), "EXCHANGE_BODY_STATE_INVALID"],
      [exchange, (x) => (x.bodyState = "NOT_READ"), "EXCHANGE_BODY_COMPLETENESS_INCONSISTENT"],
      [
        exchange,
        (x) => (x.observedBodyBytes = (x.observedBodyBytes as number) + 1),
        "EXCHANGE_BODY_INCONSISTENT",
      ],
      [exchange, (x) => (x.maxResponseBytes = null), "EXCHANGE_LIMIT_INVALID"],
      [
        exchange,
        (x) => {
          // Unread, yet carrying a body and an observed size.
          x.bodyState = "NOT_READ";
          (x.entry as Record<string, unknown>).bodyComplete = false;
        },
        "EXCHANGE_BODY_INCONSISTENT",
      ],
      [
        exchange,
        (x) => {
          // A partial body whose observed size does not exceed the limit.
          x.bodyState = "PARTIAL_OVERFLOW";
          (x.entry as Record<string, unknown>).bodyComplete = false;
        },
        "EXCHANGE_OVERFLOW_WITHIN_LIMIT",
      ],
      [TR, (t) => (record(t, isMessage).payload = null), "TRANSPORT_RECORD_PAYLOAD_MISSING"],
      [TR, (t) => delete record(t, isMessage).payload, "TRANSPORT_RECORD_PAYLOAD_MISSING"],
      [
        TR,
        (t) =>
          (record(t, (r) => r.kind === "EVENT" && r.event === "open").payload = record(
            t,
            isMessage,
          ).payload),
        "TRANSPORT_RECORD_PAYLOAD_UNEXPECTED",
      ],
      [
        TR,
        (t) => (record(t, (r) => r.kind === "COMPLETION").payload = null),
        "TRANSPORT_RECORD_PAYLOAD_UNEXPECTED",
      ],
      [
        TR,
        (t) => (record(t, isMessage).category = "lifecycle"),
        "TRANSPORT_RECORD_CATEGORY_INVALID",
      ],
      [TR, (t) => (record(t, isMessage).kind = "OTHER"), "TRANSPORT_RECORD_KIND_INVALID"],
      [
        COL,
        (c) => (c.frameRecords = { status: "READ" }),
        "COMPONENT_SECTION_MALFORMED:collectorFrameRecords",
      ],
      [
        COL,
        (c) => ((c.frameRecords as Record<string, unknown>).extra = 1),
        "COMPONENT_SECTION_MALFORMED:collectorFrameRecords",
      ],
      [
        COL,
        (c) => (c.epochReport = { status: "READ_FAILED", code: "free text" }),
        "COMPONENT_SECTION_MALFORMED:collectorEpochReport",
      ],
      [
        COL,
        (c) =>
          ((
            get(c, "counters", "value", "metadataRetention") as Record<string, unknown>
          ).frameRecordsRetained = "4"),
        "COMPONENT_SECTION_MALFORMED:collectorCounters",
      ],
      [
        COL,
        (c) => (c.notifications = { status: "MAYBE" }),
        "COMPONENT_SECTION_MALFORMED:collectorNotifications",
      ],
      [
        CPMM_EVIDENCE_FILES.sessionLedger,
        (s) => ((s.window as { value: unknown[] }).value = [{}]),
        "COMPONENT_SECTION_MALFORMED:sessionLedgerWindow",
      ],
      [CPMM_EVIDENCE_FILES.sessionLedger, (s) => (s.start = "0"), "SESSION_LEDGER_START_MALFORMED"],
      [
        CPMM_EVIDENCE_FILES.ownerReport,
        (o) => ((get(o, "lateEvents", "value") as Record<string, unknown>).close = "0"),
        "COMPONENT_SECTION_MALFORMED:ownerLateEvents",
      ],
      [
        REC,
        (r) => (r.fanOut = { status: "READ" }),
        "COMPONENT_SECTION_MALFORMED:fanOutDiagnostics",
      ],
      [
        REC,
        (r) => delete (r.pending as Record<string, unknown>).accountSettlementsPending,
        "RECORDING_PENDING_MALFORMED",
      ],
      [
        REC,
        (r) =>
          ((get(r, "pending", "completionsAwaitingFirstCall") as Record<string, unknown>).send =
            "0"),
        "RECORDING_PENDING_MALFORMED",
      ],
      [
        REC,
        (r) => ((r.pending as Record<string, unknown>).extra = 0),
        "RECORDING_PENDING_MALFORMED",
      ],
      [
        REC,
        (r) => {
          const s = get(r, "retention", "incoming") as Record<string, number>;
          s.observed = s.observed! + 1;
          s.retained = s.retained! + 1;
        },
        "RECORD_COUNT_INCONSISTENT:incoming",
      ],
      [
        REC,
        (r) => ((get(r, "retention", "outgoing") as Record<string, number>).observed = 99),
        "RECORD_COUNT_INCONSISTENT:outgoing",
      ],
      [
        REC,
        (r) => ((r.instrumentation as Record<string, unknown>).complete = false),
        "RECORDING_INSTRUMENTATION_INCONSISTENT",
      ],
      [REC, (r) => (r.ledgerRecorded = "yes"), "RECORDING_SCOPE_MALFORMED"],
      [
        CPMM_EVIDENCE_FILES.ledger,
        (l) => (l.calls = [{ kind: "OTHER" }]),
        "LEDGER_CALLS_MALFORMED",
      ],
    ];
    for (const [file, mutate, expected] of cases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      integrityFails(d, expected);
    }
  });

  it("N4: controls: legitimate nulls, fixed-code read failures and absent components pass integrity", async () => {
    const { dir } = await shared;
    const records = readJson(dir, CPMM_EVIDENCE_FILES.transportRecords).records as Record<
      string,
      unknown
    >[];
    const nulls = records.filter((r) => "payload" in r && r.payload === null);
    expect(nulls.map((r) => `${String(r.kind)}:${String(r.event ?? r.method)}`)).toEqual(
      expect.arrayContaining(["CALL:close", "CALL:start", "EVENT:close", "EVENT:open"]),
    );
    expect(records.some((r) => r.kind === "COMPLETION" && !("payload" in r))).toBe(true);
    expect(verifyCpmmObservationEvidence(dir)).toMatchObject({
      integrity: { ok: true, problems: [] },
      retention: { status: "COMPLETE", reasons: [] },
    });
    const sections: [string, (d: Record<string, unknown>) => void, string][] = [
      [
        CPMM_EVIDENCE_FILES.ownerReport,
        (o) => (o.lateEvents = { status: "READ_FAILED", code: "THREW" }),
        "COMPONENT_UNAVAILABLE:ownerLateEvents",
      ],
      [
        CPMM_EVIDENCE_FILES.ledger,
        (l) => (l.epochs = { status: "NOT_SUPPLIED" }),
        "COMPONENT_UNAVAILABLE:ledgerEpochs",
      ],
      [
        CPMM_EVIDENCE_FILES.collector,
        (c) => ((c.epochReport as Record<string, unknown>).value = null),
        "COLLECTOR_EPOCH_REPORT_MISSING",
      ],
    ];
    for (const [file, mutate, reason] of sections) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const v = verifyCpmmObservationEvidence(d);
      expect(v.integrity, reason).toEqual({ ok: true, problems: [] });
      expect(v.retention, reason).toEqual({ status: "INCOMPLETE", reasons: [reason] });
    }
  });

  it("N5: sealing refuses the same contradictions in the snapshot before any directory exists", async () => {
    const { run } = await shared;
    const copy = () => JSON.parse(JSON.stringify(run.snapshot)) as Record<string, unknown>;
    const comp = (s: Record<string, unknown>) =>
      s.components as Record<string, Record<string, unknown>>;
    const firstExchange = (s: Record<string, unknown>) =>
      (s.exchanges as Record<string, unknown>[])[0]!;
    const cases: [(s: Record<string, unknown>) => void, string][] = [
      [
        (s) =>
          ((s.incoming as Record<string, unknown>[]).find((r) => r.event === "message")!.payload =
            null),
        "TRANSPORT_RECORD_PAYLOAD_MISSING",
      ],
      [(s) => (firstExchange(s).body = null), "EXCHANGE_BODY_MISSING"],
      [(s) => (firstExchange(s).requestBody = null), "EXCHANGE_REQUEST_BODY_INCONSISTENT"],
      [
        (s) => (comp(s).collectorFrameRecords = { status: "READ" }),
        "COMPONENT_SECTION_MALFORMED:collectorFrameRecords",
      ],
      [
        (s) =>
          ((
            get(comp(s), "collectorCounters", "value", "metadataRetention") as Record<
              string,
              unknown
            >
          ).complete = false),
        "COLLECTOR_RETENTION_CONTRADICTORY:counters",
      ],
      [
        (s) => delete (s.pending as Record<string, unknown>).transportCallsInProgress,
        "RECORDING_PENDING_MALFORMED",
      ],
      [
        (s) => ((get(s, "retention", "lifecycle") as Record<string, number>).retained = 0),
        "RECORD_COUNT_INCONSISTENT:lifecycle",
      ],
    ];
    for (const [mutate, expected] of cases) {
      const s = copy();
      mutate(s);
      const input = sealInput(s as unknown as CpmmObservationSnapshot, run.recorder);
      expect(sealCpmmObservationEvidence(input), expected).toMatchObject({
        ok: false,
        status: "SEAL_INPUT_INVALID",
        code: `SNAPSHOT_STRUCTURE_INVALID:${expected}`,
      });
      expect(existsSync(path.join(input.projectRoot, "data")), expected).toBe(false);
    }
  });
});

describe("Response-limit relationships (review of 55daf13)", () => {
  /** The effective limit: the stricter of the lane (200,000) and the adapter's request (100,000). */
  const LIMIT = ADAPTER_LIMITS.maxResponseBytes;
  const exchangeFileOf = (dir: string) =>
    (readJson(dir, CPMM_EVIDENCE_FILES.exchangeIndex).exchanges as { path: string }[])[0]!.path;
  /** Rewrites the exchange and keeps the session window's `bodyComplete` in agreement. */
  const rewrite = (dir: string, mutate: (x: Record<string, unknown>) => void) => {
    const file = exchangeFileOf(dir);
    const seq = get(readJson(dir, file), "entry", "seq");
    reseal(dir, file, mutate);
    const bodyComplete = get(readJson(dir, file), "entry", "bodyComplete");
    reseal(dir, CPMM_EVIDENCE_FILES.sessionLedger, (s) => {
      for (const e of get(s, "window", "value") as Record<string, unknown>[]) {
        if (e.seq === seq) e.bodyComplete = bodyComplete;
      }
    });
  };
  const partial = (observed: (o: number) => number, limit: (o: number) => number) => {
    return (x: Record<string, unknown>) => {
      const original = get(x, "body", "originalBytes") as number;
      x.bodyState = "PARTIAL_OVERFLOW";
      (x.entry as Record<string, unknown>).bodyComplete = false;
      x.observedBodyBytes = observed(original);
      x.maxResponseBytes = limit(original);
    };
  };

  it("N6: limits and observed sizes that the bounded reader cannot produce fail integrity", async () => {
    const { dir } = await shared;
    const clean = readJson(dir, exchangeFileOf(dir));
    expect(clean).toMatchObject({ bodyState: "COMPLETE", maxResponseBytes: LIMIT });
    expect(clean.observedBodyBytes).toBe(get(clean, "body", "originalBytes"));
    const cases: [(x: Record<string, unknown>) => void, string][] = [
      // The review's reproduction: the clean 2,373-byte complete response under a limit of 1 or 0.
      [(x) => (x.maxResponseBytes = 1), "EXCHANGE_BODY_EXCEEDS_LIMIT"],
      [(x) => (x.maxResponseBytes = 0), "EXCHANGE_LIMIT_INVALID"],
      [(x) => (x.maxResponseBytes = -1), "EXCHANGE_LIMIT_INVALID"],
      [(x) => (x.maxResponseBytes = 1.5), "EXCHANGE_LIMIT_INVALID"],
      [(x) => (x.maxResponseBytes = String(LIMIT)), "EXCHANGE_LIMIT_INVALID"],
      [
        (x) => (x.maxResponseBytes = (x.observedBodyBytes as number) - 1),
        "EXCHANGE_BODY_EXCEEDS_LIMIT",
      ],
      // The review's second reproduction: an overflow claimed one byte past the original, far
      // below the limit, with the session window in agreement.
      [
        partial(
          (o) => o + 1,
          () => LIMIT,
        ),
        "EXCHANGE_OVERFLOW_WITHIN_LIMIT",
      ],
      [
        partial(
          (o) => o,
          (o) => o,
        ),
        "EXCHANGE_OVERFLOW_WITHIN_LIMIT",
      ],
      // Beyond the limit, but the retained prefix is not the limit's length.
      [
        partial(
          (o) => o + 1,
          (o) => o - 1,
        ),
        "EXCHANGE_PREFIX_LENGTH_INCONSISTENT",
      ],
      [
        partial(
          (o) => o + 10,
          (o) => o + 1,
        ),
        "EXCHANGE_PREFIX_LENGTH_INCONSISTENT",
      ],
    ];
    for (const [mutate, expected] of cases) {
      const d = copyOf(dir);
      rewrite(d, mutate);
      const v = verifyCpmmObservationEvidence(d);
      expect(v.integrity.problems, expected).toContain(expected);
      expect(v.retention, expected).toEqual({ status: "NOT_EVALUATED", reasons: [] });
    }
    // The shape the bounded reader does produce (prefix = limit < observed) is accepted, and
    // retention says the body is partial.
    const ok = copyOf(dir);
    rewrite(
      ok,
      partial(
        (o) => o + 1,
        (o) => o,
      ),
    );
    const v = verifyCpmmObservationEvidence(ok);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.retention.reasons).toEqual(["EXCHANGE_BODY_PARTIAL"]);
  });

  it("N7: sealing refuses the same limit relationships before any directory exists", async () => {
    const { run } = await shared;
    const cases: [(x: Record<string, unknown>) => void, string][] = [
      [(x) => (x.maxResponseBytes = 1), "EXCHANGE_BODY_EXCEEDS_LIMIT"],
      [(x) => (x.maxResponseBytes = 0), "EXCHANGE_LIMIT_INVALID"],
      [
        (x) => {
          x.bodyState = "PARTIAL_OVERFLOW";
          (x.entry as Record<string, unknown>).bodyComplete = false;
          x.observedBodyBytes = (get(x, "body", "byteLength") as number) + 1;
        },
        "EXCHANGE_OVERFLOW_WITHIN_LIMIT",
      ],
      [
        (x) => {
          const original = get(x, "body", "byteLength") as number;
          x.bodyState = "PARTIAL_OVERFLOW";
          (x.entry as Record<string, unknown>).bodyComplete = false;
          x.observedBodyBytes = original + 1;
          x.maxResponseBytes = original - 1;
        },
        "EXCHANGE_PREFIX_LENGTH_INCONSISTENT",
      ],
    ];
    for (const [mutate, expected] of cases) {
      const s = JSON.parse(JSON.stringify(run.snapshot)) as Record<string, unknown>;
      mutate((s.exchanges as Record<string, unknown>[])[0]!);
      const input = sealInput(s as unknown as CpmmObservationSnapshot, run.recorder);
      expect(sealCpmmObservationEvidence(input), expected).toMatchObject({
        ok: false,
        status: "SEAL_INPUT_INVALID",
        code: `SNAPSHOT_STRUCTURE_INVALID:${expected}`,
      });
      expect(existsSync(path.join(input.projectRoot, "data")), expected).toBe(false);
    }
  });

  it("N8: controls: an empty complete body, completion exactly at the limit, overflow by one byte, and a redacted body", async () => {
    const cases: [string, Responder, string, number, number, string[]][] = [
      ["empty", async () => new Response("", { status: 200 }), "COMPLETE", 0, 0, []],
      [
        "at the limit",
        async () => new Response("x".repeat(LIMIT), { status: 200 }),
        "COMPLETE",
        LIMIT,
        LIMIT,
        [],
      ],
      [
        "one byte beyond",
        async () => new Response("x".repeat(LIMIT + 1), { status: 200 }),
        "PARTIAL_OVERFLOW",
        LIMIT + 1,
        LIMIT,
        ["EXCHANGE_BODY_PARTIAL"],
      ],
    ];
    for (const [label, responder, state, observed, original, reasons] of cases) {
      const run = await genuineRun({ responder });
      const r = sealCpmmObservationEvidence(sealInput(run.snapshot, run.recorder));
      expect(r.ok, label).toBe(true);
      if (!r.ok) continue;
      const ex = readJson(r.outDir, exchangeFileOf(r.outDir));
      expect(ex, label).toMatchObject({
        bodyState: state,
        observedBodyBytes: observed,
        maxResponseBytes: LIMIT,
        body: { originalBytes: original },
      });
      const v = verifyCpmmObservationEvidence(r.outDir);
      expect(v.integrity, label).toEqual({ ok: true, problems: [] });
      expect(v.retention, label).toEqual({
        status: reasons.length === 0 ? "COMPLETE" : "INCOMPLETE",
        reasons,
      });
      expectReproduced(v);
      expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    }
    // Redaction changes the stored length; the rules compare original byte counts.
    const run = await genuineRun({
      responder: async ({ id }) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id, result: null, note: SECRET }), {
          status: 200,
        }),
    });
    const r = sealCpmmObservationEvidence(sealInput(run.snapshot, run.recorder));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ex = readJson(r.outDir, exchangeFileOf(r.outDir));
    expect(ex.body).toMatchObject({ payloadRedacted: true });
    expect(get(ex, "body", "storedBytes")).not.toBe(get(ex, "body", "originalBytes"));
    expect(ex.observedBodyBytes).toBe(get(ex, "body", "originalBytes"));
    expect(verifyCpmmObservationEvidence(r.outDir).integrity).toEqual({ ok: true, problems: [] });
  });
});

describe("Re-derivation, partial (item G): pool context and collector replay", () => {
  type Run = Awaited<ReturnType<typeof genuineRun>>;
  const sealRun = (run: Run) => {
    const r = sealCpmmObservationEvidence(
      sealInput(run.snapshot, run.recorder, {}, run.recorderLimits, run.collectorLimits),
    );
    if (!r.ok) throw new Error(`seal failed: ${r.code}`);
    return r.outDir;
  };
  const components = (dir: string) => {
    const v = verifyCpmmObservationEvidence(dir);
    expect(v.integrity, "integrity").toEqual({ ok: true, problems: [] });
    expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
    expect(v.acquisitionProvenance).toBe("OPEN_G3");
    return { v, ...v.rederivation.components! };
  };
  const TR = CPMM_EVIDENCE_FILES.transportRecords;
  const records = (doc: Record<string, unknown>) => doc.records as Record<string, unknown>[];
  const messages = (doc: Record<string, unknown>) =>
    records(doc).filter((r) => r.kind === "EVENT" && r.event === "message");
  const isUtf8 = (b: Buffer) => {
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  };
  const bytesOf = (p: Record<string, unknown>) =>
    p.storedEncoding === "base64"
      ? Buffer.from(p.stored as string, "base64")
      : Buffer.from(p.stored as string, "utf8");
  /** A consistent payload rewrite (digests and sizes kept true; redaction flags honest). */
  const setBytes = (p: Record<string, unknown>, bytes: Buffer, redacted: boolean) => {
    const utf8 = isUtf8(bytes);
    Object.assign(p, {
      storedEncoding: utf8 ? "utf8" : "base64",
      stored: utf8 ? bytes.toString("utf8") : bytes.toString("base64"),
      storedBytes: bytes.length,
      storedSha256: sha(bytes),
    });
    if (redacted) Object.assign(p, { payloadRedacted: true, redactions: 1 });
    else Object.assign(p, { originalBytes: bytes.length, originalSha256: sha(bytes) });
  };
  const accountData = (doc: Record<string, unknown>, name: string) =>
    get(doc, "accounts", name, "data") as Record<string, unknown>;

  it("G1: a genuine clean run reproduces its pool context and its whole collection; the sealed report's claims stay separate", async () => {
    const { dir } = await shared;
    const { v, poolContext, collector } = components(dir);
    expect(poolContext).toEqual({ status: "REPRODUCED", findings: [] });
    expect(collector).toEqual({
      status: "REPRODUCED",
      findings: [],
      handedOverMessages: 4,
      replayedFrames: 4,
      structurallyCheckedFrames: 0,
      epochReportCompared: true,
      countersCompared: true,
    });
    expect(v.rederivation.status).toBe("PARTIAL");
    expect(v.rederivation.implementedComponents).toBe("REPRODUCED");
    // The sealed report still says what the sealer could say; verification computed the rest.
    expect(v.sealedClaims).toMatchObject({
      rederivation: { status: "NOT_IMPLEMENTED" },
      poolContextProvenance: "SUPPLIED_UNVERIFIED",
      acquisitionProvenance: "OPEN_G3",
      runOutcome: { connectionRunClean: true },
    });
    // The two identical notifications are resolved by order alone: swapping them changes nothing.
    const d = copyOf(dir);
    reseal(d, TR, (t) => {
      const [, first, second] = messages(t);
      [first!.payload, second!.payload] = [second!.payload, first!.payload];
    });
    expect(components(d).collector.status).toBe("REPRODUCED");
  });

  it("G2: altered raw accounts, identities, slots, bindings or adapted pool are mismatches; redaction and withholding are reported as such", async () => {
    const { dir } = await shared;
    const PC = CPMM_EVIDENCE_FILES.poolContext;
    const cases: [string, (d: Record<string, unknown>) => void, string][] = [
      [
        PC,
        (c) => {
          const p = accountData(c, "vault0");
          const b = bytesOf(p);
          b[64] = b[64]! ^ 0x01; // the SPL token amount
          setBytes(p, b, false);
        },
        "MISMATCH:ADAPTED_POOL",
      ],
      [
        PC,
        (c) =>
          ((get(c, "accounts", "pool") as Record<string, unknown>).ownerProgramId =
            SPL_TOKEN_PROGRAM_ID),
        "MISMATCH:ADAPTER_REFUSED",
      ],
      [
        PC,
        (c) => ((get(c, "accounts", "vault1") as Record<string, unknown>).slot = 300_000_001),
        "MISMATCH:ADAPTER_REFUSED" /* SLOT_DISCREPANCY */,
      ],
      [
        PC,
        (c) => ((get(c, "adaptedPool", "baseVaultRaw") as Record<string, unknown>).$bigint = "1"),
        "MISMATCH:ADAPTED_POOL",
      ],
      [
        CPMM_EVIDENCE_FILES.plan,
        (p) => ((get(p, "plan", "binding") as Record<string, unknown>).candidateMint = WSOL_MINT),
        "MISMATCH:TARGET_BINDING",
      ],
      [
        CPMM_EVIDENCE_FILES.collector,
        (c) =>
          ((get(c, "epochReport", "value", "binding") as Record<string, unknown>).candidateMint =
            WSOL_MINT),
        "MISMATCH:COLLECTOR_BINDING",
      ],
      [
        PC,
        (c) => {
          const p = accountData(c, "vault0");
          const b = bytesOf(p);
          b[100] = b[100]! ^ 0xff;
          setBytes(p, b, true);
        },
        "LIMITED_BY_REDACTION:ACCOUNT_DATA_REDACTED:vault0",
      ],
      [
        PC,
        (c) =>
          Object.assign(accountData(c, "pool"), {
            storedEncoding: null,
            stored: null,
            storedBytes: null,
            storedSha256: null,
            withheldReason: "CREDENTIAL_SCAN_INCONCLUSIVE",
            jsonInspection: null,
          }),
        "MISSING_EVIDENCE:ACCOUNT_DATA_UNAVAILABLE:pool",
      ],
    ];
    for (const [file, mutate, finding] of cases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const { poolContext, v } = components(d);
      expect(poolContext.findings, finding).toContain(finding);
      expect(poolContext.status, finding).toBe(finding.split(":")[0]);
      expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
    }
    // An unrelated redaction never hides a contradiction.
    const d = copyOf(dir);
    reseal(d, PC, (c) => {
      const p = accountData(c, "vault0");
      const b = bytesOf(p);
      b[100] = b[100]! ^ 0xff;
      setBytes(p, b, true);
      (c.target as Record<string, unknown>).candidateMint = WSOL_MINT;
    });
    const { poolContext } = components(d);
    expect(poolContext.status).toBe("MISMATCH");
    expect(poolContext.findings).toEqual(
      expect.arrayContaining([
        "MISMATCH:TARGET_BINDING",
        "LIMITED_BY_REDACTION:ACCOUNT_DATA_REDACTED:vault0",
      ]),
    );
  });

  it("G3: reordered messages, altered receipt times, transitions, reports and counts are mismatches", async () => {
    const { dir } = await shared;
    const COL = CPMM_EVIDENCE_FILES.collector;
    const cases: [string, (d: Record<string, unknown>) => void, string][] = [
      [
        TR,
        (t) => {
          const [ack, note] = messages(t);
          [ack!.payload, note!.payload] = [note!.payload, ack!.payload];
        },
        "MISMATCH:FRAME_ASSOCIATION",
      ],
      [
        COL,
        (c) => {
          const fr = (get(c, "frameRecords", "value") as Record<string, number>[])[1]!;
          fr.receivedAtMs = fr.receivedAtMs! + 1;
        },
        "MISMATCH:NOTIFICATIONS",
      ],
      [
        TR,
        (t) => {
          const send = records(t).find((r) => r.kind === "CALL" && r.method === "send")!;
          const p = send.payload as Record<string, unknown>;
          setBytes(
            p,
            Buffer.from(bytesOf(p).toString("utf8").replace(`"id":${SUB_REQ}`, '"id":99')),
            false,
          );
        },
        "MISMATCH:SUBSCRIBE_FRAME",
      ],
      [
        TR,
        (t) => {
          const send = records(t).filter((r) => r.kind === "CALL" && r.method === "send")[1]!;
          const p = send.payload as Record<string, unknown>;
          setBytes(p, Buffer.from(bytesOf(p).toString("utf8").replace("4242", "4243")), false);
        },
        "MISMATCH:UNSUBSCRIBE_FRAME",
      ],
      [
        COL,
        (c) =>
          ((get(c, "epochReport", "value") as Record<string, unknown>).closeReason =
            "TRANSPORT_CLOSED"),
        "MISMATCH:EPOCH_REPORT",
      ],
      [
        COL,
        (c) => {
          const counters = get(c, "counters", "value") as Record<string, number>;
          counters.bytes = counters.bytes! + 1;
        },
        "MISMATCH:COUNTERS",
      ],
      [
        COL,
        (c) => ((get(c, "frameRecords", "value") as Record<string, unknown>[])[0]!.code = "OTHER"),
        "MISMATCH:FRAME_RECORDS",
      ],
      [
        COL,
        (c) => ((get(c, "frameRecords", "value") as Record<string, unknown>[])[2]!.sequence = 9),
        "MISMATCH:FRAME_ORDER",
      ],
      [
        CPMM_EVIDENCE_FILES.ownerReport,
        (o) =>
          ((get(o, "report", "value", "incoming") as Record<string, number>).messagesBeforeStart =
            1),
        "MISMATCH:BEFORE_START_COUNT",
      ],
      [
        CPMM_EVIDENCE_FILES.ownerReport,
        (o) =>
          ((get(o, "report", "value", "incoming") as Record<string, number>).passedToCollector = 3),
        "MISMATCH:HANDED_OVER_COUNT",
      ],
      [
        CPMM_EVIDENCE_FILES.ownerReport,
        (o) =>
          ((get(o, "report", "value", "intake") as Record<string, number>).framesAfterIntake = 1),
        "MISMATCH:AFTER_INTAKE_COUNT",
      ],
    ];
    for (const [file, mutate, finding] of cases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const { collector } = components(d);
      expect(collector.findings, finding).toContain(finding);
      expect(collector.status, finding).toBe("MISMATCH");
    }
  });

  it("G4: before-start and after-intake messages are excluded by the owner's own split, and the rest reproduces", async () => {
    // A message delivered after the owner registered its listeners but before start().
    const early = Buffer.from('{"jsonrpc":"2.0","method":"early"}');
    const beforeStart = (inner: CpmmOwnerTransport): CpmmOwnerTransport => {
      const listeners: ((d: unknown) => void)[] = [];
      let fired = false;
      const on = (event: string, l: (...a: unknown[]) => void) => {
        const d = (
          inner as unknown as { on: (e: string, l: (...a: unknown[]) => void) => () => void }
        ).on(event, l);
        if (event === "message") listeners.push(l);
        if (event === "open" && listeners.length === 2 && !fired) {
          fired = true;
          for (const m of [...listeners]) m(early);
        }
        return d;
      };
      return {
        get readyState() {
          return inner.readyState;
        },
        start: () => inner.start(),
        send: (d, done) => inner.send(d, done),
        ping: (p, done) => inner.ping(p, done),
        pong: (p, done) => inner.pong(p, done),
        close: (c) => inner.close(c),
        terminate: () => inner.terminate(),
        dispose: () => inner.dispose(),
        on: on as CpmmOwnerTransport["on"],
      };
    };
    // The accepted owner ends such a run (EVENT_BEFORE_START) without starting the transport.
    const ea = env({}, {}, { wrapTransport: beforeStart });
    const pa = ea.owner.run();
    await ea.to(OBS_START + 10);
    const ra = await pa;
    expect(ra.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "EVENT_BEFORE_START" });
    expect(ra.incoming.messagesBeforeStart).toBe(1);
    const sa = sealCpmmObservationEvidence(sealInput(ea.finish(ra), ea.recorder));
    expect(sa.ok).toBe(true);
    if (!sa.ok) return;
    const { collector: ca, v: va } = components(sa.outDir);
    expect(ca).toEqual({
      status: "REPRODUCED",
      findings: [],
      handedOverMessages: 0,
      replayedFrames: 0,
      structurallyCheckedFrames: 0,
      epochReportCompared: true,
      countersCompared: true,
    });
    expect(va.sealedClaims).toMatchObject({
      runOutcome: { terminal: { code: "EVENT_BEFORE_START" } },
    });
    // Claimed as handed over instead, the same message contradicts the owner's own split.
    const da = copyOf(sa.outDir);
    reseal(da, CPMM_EVIDENCE_FILES.ownerReport, (o) => {
      (get(o, "report", "value", "incoming") as Record<string, number>).messagesBeforeStart = 0;
    });
    expect(components(da).collector.findings).toContain("MISMATCH:BEFORE_START_COUNT");
    // A message after the unsubscribe acknowledgement, while the socket is still open: the owner
    // had already disposed its message listener, so it is wrapper-only and never counted.
    const b = await genuineRun({ closeMode: "none", afterIntake: Buffer.from('{"late":true}') });
    expect(b.report.intake.framesAfterIntake).toBe(0);
    const late = b.snapshot.incoming.filter((r) => r.kind === "EVENT" && r.event === "message");
    expect(late.at(-1)).toMatchObject({
      ownerDeliveries: 0,
      delivery: "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL",
    });
    const dirB = sealRun(b);
    expect(components(dirB).collector).toMatchObject({
      status: "REPRODUCED",
      handedOverMessages: 4,
      replayedFrames: 4,
    });
    // The owner-received after-intake split (a message the owner counted but did not hand over),
    // constructed consistently from that run: accepted with the owner's counts, refused without.
    const relabel = (dir: string, withCounts: boolean) => {
      reseal(dir, TR, (t) => {
        const last = messages(t).at(-1)!;
        last.ownerDeliveries = 1;
        last.ownerRegistrationsAtDispatch = 1;
        last.delivery = "OWNER_LISTENERS_REGISTERED";
      });
      if (withCounts) {
        reseal(dir, CPMM_EVIDENCE_FILES.ownerReport, (o) => {
          (get(o, "report", "value", "intake") as Record<string, number>).framesAfterIntake = 1;
          const incoming = get(o, "report", "value", "incoming") as Record<string, number>;
          incoming.messageEvents = incoming.messageEvents! + 1;
        });
      }
    };
    const ok = copyOf(dirB);
    relabel(ok, true);
    expect(components(ok).collector).toMatchObject({ status: "REPRODUCED", handedOverMessages: 4 });
    const bad = copyOf(dirB);
    relabel(bad, false);
    expect(components(bad).collector.findings).toEqual(
      expect.arrayContaining(["MISMATCH:AFTER_INTAKE_COUNT", "MISMATCH:OWNER_MESSAGE_COUNT"]),
    );
  });

  it("G5: an unhashed terminal refusal is checked structurally, never replayed or given a time", async () => {
    const run = await genuineRun({ collectorLimits: { maxEpochFrames: 2 } });
    expect(run.report.terminal).toMatchObject({ cause: "ACQUISITION_LIMIT" });
    const dir = sealRun(run);
    const { collector, poolContext, v } = components(dir);
    expect(poolContext.status).toBe("REPRODUCED");
    expect(collector).toEqual({
      status: "MISSING_EVIDENCE",
      findings: ["MISSING_EVIDENCE:UNHASHED_TERMINAL_REFUSAL_NOT_REPLAYED"],
      handedOverMessages: 3,
      replayedFrames: 2,
      structurallyCheckedFrames: 1,
      epochReportCompared: false,
      countersCompared: false,
    });
    expect(v.rederivation.implementedComponents).toBe("MISSING_EVIDENCE");
    // The abnormal outcome stays as recorded.
    expect(v.sealedClaims).toMatchObject({
      runOutcome: { terminal: { cause: "ACQUISITION_LIMIT" } },
    });
    const COL = CPMM_EVIDENCE_FILES.collector;
    const tampered: [(c: Record<string, unknown>) => void, string][] = [
      [
        (c) =>
          ((get(c, "frameRecords", "value") as Record<string, unknown>[])[2]!.disposition =
            "NOT_JSON"),
        "MISMATCH:UNHASHED_REFUSAL_SHAPE",
      ],
      [
        // An earlier accepted frame stripped of its receipt and digest: not the last one handed over.
        (c) =>
          Object.assign((get(c, "frameRecords", "value") as Record<string, unknown>[])[1]!, {
            receivedAtMs: null,
            sha256: null,
          }),
        "MISMATCH:UNHASHED_REFUSAL_NOT_TERMINAL",
      ],
      [
        // The notification replayed before the refusal is compared with the recorded one.
        (c) => {
          const n = (get(c, "notifications", "value") as Record<string, number>[])[0]!;
          n.slot = n.slot! + 1;
        },
        "MISMATCH:NOTIFICATIONS",
      ],
      [
        (c) => {
          const fr = (get(c, "frameRecords", "value") as Record<string, number>[])[2]!;
          fr.byteLength = fr.byteLength! + 1;
        },
        "MISMATCH:FRAME_ASSOCIATION",
      ],
    ];
    for (const [mutate, finding] of tampered) {
      const d = copyOf(dir);
      reseal(d, COL, mutate);
      const c = components(d).collector;
      expect(c.findings, finding).toContain(finding);
      expect(c.status, finding).toBe("MISMATCH");
    }
  });

  it("G6: missing or redacted frame material stops replay explicitly; an unrelated redaction neither limits nor hides", async () => {
    // A credential in both notifications: the second frame cannot be replayed exactly.
    const red = await genuineRun({ logs: [`Program log: ${SECRET}`] });
    const redDir = sealRun(red);
    const rc = components(redDir).collector;
    expect(rc).toEqual({
      status: "LIMITED_BY_REDACTION",
      findings: ["LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED"],
      handedOverMessages: 4,
      replayedFrames: 1,
      structurallyCheckedFrames: 3,
      epochReportCompared: false,
      countersCompared: false,
    });
    // A contradiction beyond the redacted frame is still a mismatch.
    const d = copyOf(redDir);
    reseal(d, CPMM_EVIDENCE_FILES.collector, (c) => {
      (get(c, "frameRecords", "value") as Record<string, unknown>[])[3]!.sha256 = "0".repeat(64);
    });
    const dc = components(d).collector;
    expect(dc.status).toBe("MISMATCH");
    expect(dc.findings).toEqual(
      expect.arrayContaining([
        "MISMATCH:FRAME_ASSOCIATION",
        "LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED",
      ]),
    );
    // What was replayed before the stop is still compared.
    const prefix = copyOf(redDir);
    reseal(prefix, CPMM_EVIDENCE_FILES.collector, (c) => {
      (get(c, "frameRecords", "value") as Record<string, unknown>[])[0]!.code = "OTHER";
    });
    expect(components(prefix).collector.findings).toContain("MISMATCH:FRAME_RECORDS");
    // A credential in a control payload is redacted but irrelevant to the collector.
    const ping = await genuineRun({ pingPayload: Buffer.from(`p:${SECRET}`) });
    const pingDir = sealRun(ping);
    const pc = components(pingDir).collector;
    expect(pc).toMatchObject({ status: "REPRODUCED", findings: [], replayedFrames: 4 });
    // An omitted payload, dropped frame records and dropped recorder records are missing evidence.
    const missing: [Parameters<typeof genuineRun>[0], string[], number][] = [
      [
        { limits: { maxIncomingPayloadBytes: 8 } },
        ["MISSING_EVIDENCE:FRAME_PAYLOAD_UNAVAILABLE"],
        0,
      ],
      [
        { collectorLimits: { maxRetainedFrameRecords: 1 } },
        // The retained notifications validly reference frames whose records were not retained.
        [
          "MISSING_EVIDENCE:FRAME_RECORDS_DROPPED",
          "MISSING_EVIDENCE:NOTIFICATION_FRAME_NOT_RETAINED",
        ],
        1,
      ],
      [
        { limits: { maxIncomingRecords: 2 } },
        ["MISSING_EVIDENCE:TRANSPORT_RECORDS_DROPPED:incoming"],
        0,
      ],
    ];
    for (const [o, findings, replayed] of missing) {
      const finding = findings[0]!;
      const run = await genuineRun(o);
      const c = components(sealRun(run)).collector;
      expect(c.findings, finding).toEqual(findings);
      expect(c.status, finding).toBe("MISSING_EVIDENCE");
      expect(c.replayedFrames, finding).toBe(replayed);
      expect(c.epochReportCompared, finding).toBe(false);
    }
  });

  it("G7: missing components are missing evidence, never a reproduction", async () => {
    // The recorder over the wrapper alone: no collector, owner or session reads at all.
    const m = wrapperOnly();
    m.c.message(Buffer.from('{"x":1}'));
    const r = sealCpmmObservationEvidence(
      sealInput(m.r.finish(NO_COMPONENTS), m.r, {}, m.recorderLimits),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { collector, poolContext } = components(r.outDir);
    expect(collector).toMatchObject({
      status: "MISSING_EVIDENCE",
      findings: ["MISSING_EVIDENCE:COLLECTOR_COMPONENT_UNAVAILABLE"],
      replayedFrames: 0,
    });
    // The accounts re-adapt, but no component binding was read to confirm them against.
    expect(poolContext).toEqual({
      status: "MISSING_EVIDENCE",
      findings: [
        "MISSING_EVIDENCE:COLLECTOR_BINDING_UNAVAILABLE",
        "MISSING_EVIDENCE:OWNER_BINDING_UNAVAILABLE",
      ],
    });
    // Without the owner's counts, replay still runs but cannot be called a reproduction.
    const { dir } = await shared;
    const d = copyOf(dir);
    reseal(
      d,
      CPMM_EVIDENCE_FILES.ownerReport,
      (o) => (o.lateEvents = { status: "READ_FAILED", code: "THREW" }),
    );
    const c = components(d).collector;
    expect(c).toMatchObject({
      status: "MISSING_EVIDENCE",
      findings: ["MISSING_EVIDENCE:OWNER_COUNTS_UNAVAILABLE"],
      replayedFrames: 4,
      epochReportCompared: true,
    });
    const e = copyOf(dir);
    reseal(e, CPMM_EVIDENCE_FILES.collector, (o) => (o.counters = { status: "NOT_SUPPLIED" }));
    expect(components(e).collector.findings).toEqual([
      "MISSING_EVIDENCE:COLLECTOR_COMPONENT_UNAVAILABLE",
    ]);
  });

  it("G8: faithful incomplete runs reproduce what they recorded, without upgrading their outcome", async () => {
    // The unsubscribe is built and sent, but no acknowledgement arrives: built after the last frame.
    const unacked = await genuineRun({ noUnsubscribeAck: true });
    expect(unacked.report.intake.trigger).toBe("INTAKE_DEADLINE");
    const ud = sealRun(unacked);
    const uc = components(ud);
    expect(uc.collector).toMatchObject({
      status: "REPRODUCED",
      replayedFrames: 3,
      epochReportCompared: true,
    });
    expect(
      get(readJson(ud, CPMM_EVIDENCE_FILES.collector), "epochReport", "value", "unsubscribe"),
    ).toMatchObject({
      status: "BUILT_UNOBSERVED",
    });
    for (const responder of [
      async () => new Response("x".repeat(200_001), { status: 200 }),
      async () => {
        throw new Error("transport failure");
      },
    ] as Responder[]) {
      const dir = sealRun(await genuineRun({ responder }));
      const { v, poolContext, collector } = components(dir);
      expect(v.retention.status).toBe("INCOMPLETE");
      expect(poolContext.status).toBe("REPRODUCED");
      expect(collector.status).toBe("REPRODUCED");
      expect(v.rederivation.components!.transactionAnalysis).toEqual({ status: "NOT_IMPLEMENTED" });
      expect(v.rederivation.components!.runtimeAccounting).toEqual({
        status: "RUNTIME_ACCOUNTING_NOT_REPRODUCED",
      });
    }
  });
});

describe("Re-derivation corrections (review of b5308e4)", () => {
  const COL = CPMM_EVIDENCE_FILES.collector;
  const integrityFailsWith = (dir: string, problem: string) => {
    let v: ReturnType<typeof verifyCpmmObservationEvidence> | null = null;
    expect(() => (v = verifyCpmmObservationEvidence(dir)), problem).not.toThrow();
    const r = v as unknown as ReturnType<typeof verifyCpmmObservationEvidence>;
    expect(r.integrity.ok, problem).toBe(false);
    expect(r.integrity.problems, problem).toContain(problem);
    expect(r.rederivation, problem).toEqual(NOT_ATTEMPTED);
    expect(r.sealedClaims, problem).toBeNull();
    expect(r.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
  };
  /** Replaces one file's text directly and re-digests the manifest (the report is not touched). */
  const rewriteText = (dir: string, rel: string, text: string) => {
    writeFileSync(path.join(dir, ...rel.split("/")), text);
    reseal(dir, CPMM_EVIDENCE_FILES.manifest, (m) => {
      m.files = (m.files as { path: string }[]).map((f) =>
        f.path === rel ? { path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) } : f,
      );
    });
  };
  const frameRecords = (c: Record<string, unknown>) =>
    get(c, "frameRecords", "value") as Record<string, unknown>[];
  const collectorOf = (dir: string) => {
    const v = verifyCpmmObservationEvidence(dir);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    return v.rederivation.components!.collector;
  };

  it("O1: deep or malformed sealed claims are a fixed integrity failure; nothing escapes as an exception", async () => {
    const { dir } = await shared;
    // The review's reproduction: 10,000 nested arrays as report.json's run outcome, as JSON text.
    const deep = copyOf(dir);
    const reportPath = path.join(deep, CPMM_EVIDENCE_FILES.report);
    const original = readFileSync(reportPath, "utf8");
    const nested = "[".repeat(10_000) + "]".repeat(10_000);
    const text = original.replace(
      /"runOutcome": \{[\s\S]*?\n {2}\},\n/,
      `"runOutcome": ${nested},\n`,
    );
    expect(text).not.toBe(original);
    expect(Buffer.byteLength(text)).toBeGreaterThan(20_000);
    rewriteText(deep, CPMM_EVIDENCE_FILES.report, text);
    integrityFailsWith(deep, "FILE_TOO_DEEP:report.json");
    // Depth is bounded for every document, not only the report.
    const deepCollector = copyOf(dir);
    const collectorText = readFileSync(path.join(deepCollector, COL), "utf8").replace(
      '"code": null',
      `"code": ${"[".repeat(200)}${"]".repeat(200)}`,
    );
    rewriteText(deepCollector, COL, collectorText);
    reseal(deepCollector, CPMM_EVIDENCE_FILES.report, (r) => {
      r.files = (r.files as { path: string }[]).map((f) =>
        f.path === COL
          ? { path: COL, bytes: Buffer.byteLength(collectorText), sha256: sha(collectorText) }
          : f,
      );
    });
    integrityFailsWith(deepCollector, "FILE_TOO_DEEP:collector.json");
    // Shallow but malformed claims.
    const claims: [(r: Record<string, unknown>) => void, string][] = [
      [(r) => (r.runOutcome = [[["x"]]]), "REPORT_RUN_OUTCOME_MALFORMED"],
      [
        (r) => ((r.runOutcome as Record<string, unknown>).terminal = { cause: { nested: true } }),
        "REPORT_RUN_OUTCOME_MALFORMED",
      ],
      [
        (r) => ((r.runOutcome as Record<string, unknown>).extra = 1),
        "REPORT_RUN_OUTCOME_MALFORMED",
      ],
      [
        (r) =>
          ((r.runOutcome as Record<string, unknown>).terminal = Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [`k${i}`, i]),
          )),
        "REPORT_RUN_OUTCOME_MALFORMED",
      ],
      [
        (r) => (r.rederivation = { status: "NOT_IMPLEMENTED", detail: [[1]] }),
        "REPORT_REDERIVATION_CLAIM_INVALID",
      ],
      [(r) => (r.acquisitionProvenance = "ACQUIRED"), "REPORT_ACQUISITION_PROVENANCE_INVALID"],
    ];
    for (const [mutate, problem] of claims) {
      const d = copyOf(dir);
      reseal(d, CPMM_EVIDENCE_FILES.report, mutate);
      integrityFailsWith(d, problem);
    }
    // Control: valid claims are copied, kept separate and immutable.
    const v = verifyCpmmObservationEvidence(dir);
    expect(v.sealedClaims).toMatchObject({ runOutcome: { cleanupStatus: "SETTLED" } });
    expect(Object.isFrozen(v.sealedClaims!.runOutcome)).toBe(true);
    expect(Object.isFrozen(v.rederivation.components!.collector.findings)).toBe(true);
  });

  it("O2: after replay stops, the collector's receipt and refusal rules are still checked on every frame", async () => {
    const red = await genuineRun({ logs: [`Program log: ${SECRET}`] });
    const r = sealCpmmObservationEvidence(sealInput(red.snapshot, red.recorder));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Control: untouched, the redaction is the only limitation.
    expect(collectorOf(r.outDir)).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      findings: ["LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED"],
    });
    const cases: [(frames: Record<string, unknown>[]) => void, string][] = [
      // The review's three reproductions, on frame 3 (beyond the stop at frame 2).
      [(f) => (f[2]!.receivedAtMs = null), "FRAME_RECEIPT_DIGEST_INCONSISTENT"],
      [
        (f) =>
          Object.assign(f[2]!, { receivedAtMs: null, sha256: null, disposition: "OVERSIZE_FRAME" }),
        "UNHASHED_REFUSAL_NOT_TERMINAL",
      ],
      [(f) => (f[2]!.receivedAtMs = -5), "FRAME_RECEIPT_INVALID"],
      // The rest of the accepted collector's rules.
      [
        (f) =>
          Object.assign(f[2]!, { receivedAtMs: null, sha256: null, disposition: "OVERSIZE_FRAME" }),
        "FRAME_LENGTH_INCONSISTENT",
      ],
      [(f) => (f[2]!.receivedAtMs = (f[1]!.receivedAtMs as number) - 1), "FRAME_RECEIPT_INVALID"],
      // Before the epoch's start, on the first frame (no earlier receipt to compare with).
      [(f) => (f[0]!.receivedAtMs = OBS_START - 1), "FRAME_RECEIPT_INVALID"],
      [(f) => (f[2]!.sha256 = "0".repeat(64)), "NOTIFICATION_FRAME_INCONSISTENT"],
      [(f) => (f[2]!.sha256 = null), "FRAME_RECEIPT_DIGEST_INCONSISTENT"],
      [(f) => (f[2]!.disposition = "EPOCH_LIMIT_EXCEEDED"), "FRAME_DISPOSITION_INCONSISTENT"],
      [(f) => (f[2]!.disposition = "INVENTED"), "FRAME_DISPOSITION_UNKNOWN"],
      [(f) => (f[2]!.byteLength = FRAME_BYTES + 1), "FRAME_LENGTH_INCONSISTENT"],
      [(f) => (f[2]!.disposition = "UNEXPECTED_METHOD"), "NOTIFICATION_FRAME_INCONSISTENT"],
      [
        (f) => (f[2]!.receivedAtMs = (f[2]!.receivedAtMs as number) + 1),
        "NOTIFICATION_FRAME_INCONSISTENT",
      ],
    ];
    for (const [mutate, code] of cases) {
      const d = copyOf(r.outDir);
      reseal(d, COL, (c) => mutate(frameRecords(c)));
      const c = collectorOf(d);
      expect(c.status, code).toBe("MISMATCH");
      expect(c.findings, code).toEqual(
        expect.arrayContaining([`MISMATCH:${code}`, "LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED"]),
      );
      // Structural checking never resumes replay through the unavailable bytes.
      expect(c, code).toMatchObject({
        replayedFrames: 1,
        structurallyCheckedFrames: 3,
        epochReportCompared: false,
      });
    }
    // Control: a legitimate unhashed terminal refusal is still only missing evidence.
    const run = await genuineRun({ collectorLimits: { maxEpochFrames: 2 } });
    const t = sealCpmmObservationEvidence(
      sealInput(run.snapshot, run.recorder, {}, run.recorderLimits, run.collectorLimits),
    );
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(collectorOf(t.outDir)).toMatchObject({
      status: "MISSING_EVIDENCE",
      findings: ["MISSING_EVIDENCE:UNHASHED_TERMINAL_REFUSAL_NOT_REPLAYED"],
    });
  });

  it("O3: the owner's recorded binding is compared; unavailable binding evidence is reported, never assumed", async () => {
    const { dir } = await shared;
    const OWN = CPMM_EVIDENCE_FILES.ownerReport;
    const cases: [string, (d: Record<string, unknown>) => void, string][] = [
      // The review's reproduction: only the owner's binding changes.
      [
        OWN,
        (o) =>
          ((get(o, "report", "value", "binding") as Record<string, unknown>).candidateMint =
            WSOL_MINT),
        "MISMATCH:OWNER_BINDING",
      ],
      [
        OWN,
        (o) =>
          ((get(o, "report", "value", "binding") as Record<string, unknown>).poolAddress =
            CANDIDATE),
        "MISMATCH:OWNER_BINDING",
      ],
      [
        OWN,
        (o) => delete (get(o, "report", "value") as Record<string, unknown>).binding,
        "MISSING_EVIDENCE:OWNER_BINDING_UNAVAILABLE",
      ],
      [
        OWN,
        (o) => (o.report = { status: "READ_FAILED", code: "THREW" }),
        "MISSING_EVIDENCE:OWNER_BINDING_UNAVAILABLE",
      ],
      [
        COL,
        (c) => ((c.epochReport as Record<string, unknown>).value = null),
        "MISSING_EVIDENCE:COLLECTOR_BINDING_UNAVAILABLE",
      ],
    ];
    for (const [file, mutate, finding] of cases) {
      const d = copyOf(dir);
      reseal(d, file, mutate);
      const v = verifyCpmmObservationEvidence(d);
      expect(v.integrity, finding).toEqual({ ok: true, problems: [] });
      const pc = v.rederivation.components!.poolContext;
      expect(pc.findings, finding).toContain(finding);
      expect(pc.status, finding).toBe(finding.split(":")[0]);
      expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
    }
    // The owner's binding is pool context: the collection itself still reproduces.
    const d = copyOf(dir);
    reseal(d, OWN, (o) => {
      (get(o, "report", "value", "binding") as Record<string, unknown>).candidateMint = WSOL_MINT;
    });
    const v = verifyCpmmObservationEvidence(d);
    expect(v.rederivation.components!.collector.status).toBe("REPRODUCED");
    expect(v.rederivation.implementedComponents).toBe("MISMATCH");
  });
});

describe("Notification structure (review of 84a5ff9)", () => {
  const COL = CPMM_EVIDENCE_FILES.collector;
  type Run = Awaited<ReturnType<typeof genuineRun>>;
  const sealRun = (run: Run) => {
    const r = sealCpmmObservationEvidence(
      sealInput(run.snapshot, run.recorder, {}, run.recorderLimits, run.collectorLimits),
    );
    if (!r.ok) throw new Error(`seal failed: ${r.code}`);
    return r.outDir;
  };
  const collectorOf = (dir: string) => {
    const v = verifyCpmmObservationEvidence(dir);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(v.poolContextProvenance).toBe("SUPPLIED_UNVERIFIED");
    return v.rederivation.components!.collector;
  };
  const notifications = (c: Record<string, unknown>) =>
    get(c, "notifications", "value") as Record<string, unknown>[];

  it("O4: after replay stops, every retained notification's identity and frame reference is still checked", async () => {
    const red = await genuineRun({ logs: [`Program log: ${SECRET}`] });
    const dir = sealRun(red);
    // Control: honest redaction is the only limitation of the untouched capture.
    expect(collectorOf(dir)).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      findings: ["LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED"],
      replayedFrames: 1,
    });
    const cases: [(c: Record<string, unknown>) => void, string][] = [
      // The review's reproductions, on the second notification (frame 3, beyond the stop).
      [(c) => (notifications(c)[1]!.frameSequence = 0), "NOTIFICATION_FRAME_REFERENCE_INVALID"],
      [(c) => (notifications(c)[1]!.frameSequence = 999), "NOTIFICATION_FRAME_REFERENCE_INVALID"],
      [(c) => (notifications(c)[1]!.frameSequence = 2.5), "NOTIFICATION_FRAME_REFERENCE_INVALID"],
      [(c) => (notifications(c)[1]!.epoch = 2), "NOTIFICATION_EPOCH_INCONSISTENT"],
      [(c) => (notifications(c)[1]!.sequence = 999), "NOTIFICATION_SEQUENCE_INCONSISTENT"],
      [
        (c) => (notifications(c)[1]!.subscriptionId = 999),
        "NOTIFICATION_SUBSCRIPTION_INCONSISTENT",
      ],
      // References must increase: two notifications cannot come from one frame.
      [(c) => (notifications(c)[1]!.frameSequence = 2), "NOTIFICATION_FRAME_REFERENCE_INVALID"],
      // Sequences follow acceptance order, and the k-th accepted frame is the k-th notification.
      [
        (c) => {
          const [a, b] = notifications(c);
          [a!.sequence, b!.sequence] = [b!.sequence, a!.sequence];
        },
        "NOTIFICATION_SEQUENCE_INCONSISTENT",
      ],
      // The referenced frame's epoch.
      [
        (c) => ((get(c, "frameRecords", "value") as Record<string, unknown>[])[2]!.epoch = 2),
        "NOTIFICATION_EPOCH_INCONSISTENT",
      ],
      // The schema and numeric domains of the accepted collector's record.
      [(c) => (notifications(c)[1]!.extra = 1), "NOTIFICATION_MALFORMED"],
      [(c) => delete notifications(c)[1]!.slot, "NOTIFICATION_MALFORMED"],
      [(c) => (notifications(c)[1]!.slot = -1), "NOTIFICATION_MALFORMED"],
      [(c) => (notifications(c)[1]!.signature = "not-a-signature"), "NOTIFICATION_MALFORMED"],
      [(c) => (notifications(c)[1]!.notifiedTransactionError = "MAYBE"), "NOTIFICATION_MALFORMED"],
      [(c) => (notifications(c)[1]!.frameSha256 = "ABC"), "NOTIFICATION_MALFORMED"],
      // More frames accepted as notifications than the collector accepted (the unsubscribe
      // acknowledgement relabelled, beyond the stop and referenced by no notification).
      [
        (c) =>
          ((get(c, "frameRecords", "value") as Record<string, unknown>[])[3]!.disposition =
            "NOTIFICATION_ACCEPTED"),
        "NOTIFICATION_COUNT_INCONSISTENT",
      ],
      // Fewer accepted notifications in the epoch than are retained.
      [
        (c) =>
          ((get(c, "epochReport", "value") as Record<string, unknown>).notificationsAccepted = 1),
        "NOTIFICATION_COUNT_INCONSISTENT",
      ],
    ];
    for (const [mutate, code] of cases) {
      const d = copyOf(dir);
      reseal(d, COL, mutate);
      const c = collectorOf(d);
      expect(c.status, code).toBe("MISMATCH");
      expect(c.findings, code).toEqual(
        expect.arrayContaining([`MISMATCH:${code}`, "LIMITED_BY_REDACTION:FRAME_PAYLOAD_REDACTED"]),
      );
      // Checked structurally only: replay is not resumed and nothing is invented.
      expect(c, code).toMatchObject({
        replayedFrames: 1,
        structurallyCheckedFrames: 3,
        epochReportCompared: false,
        countersCompared: false,
      });
    }
  });

  it("O5: controls: clean and duplicate notifications, dropped notification records, and genuinely unretained frame records", async () => {
    // A clean collection with two notifications of the same signature reproduces (G1's capture).
    const { dir } = await shared;
    const notes = notifications(readJson(dir, COL));
    expect(notes.map((n) => n.signature)).toEqual([signatureOf(1), signatureOf(1)]);
    expect(notes.map((n) => [n.sequence, n.frameSequence])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(collectorOf(dir)).toMatchObject({ status: "REPRODUCED", findings: [] });
    // Notification records dropped by the collector: the retained one still links exactly.
    const fewer = await genuineRun({ collectorLimits: { maxRetainedNotifications: 1 } });
    expect(collectorOf(sealRun(fewer))).toMatchObject({ status: "REPRODUCED", findings: [] });
    // Frame records dropped: valid references to unretained frames are missing, not contradicted.
    const dropped = await genuineRun({ collectorLimits: { maxRetainedFrameRecords: 1 } });
    const dd = sealRun(dropped);
    const c = collectorOf(dd);
    expect(c.status).toBe("MISSING_EVIDENCE");
    expect(c.findings).toEqual([
      "MISSING_EVIDENCE:FRAME_RECORDS_DROPPED",
      "MISSING_EVIDENCE:NOTIFICATION_FRAME_NOT_RETAINED",
    ]);
    // ...while an invalid reference or identity in the same capture is still a contradiction,
    // checked without the frame record.
    const unretained: [(c: Record<string, unknown>) => void, string][] = [
      [(o) => (notifications(o)[1]!.frameSequence = 999), "NOTIFICATION_FRAME_REFERENCE_INVALID"],
      [(o) => (notifications(o)[0]!.sequence = 999), "NOTIFICATION_SEQUENCE_INCONSISTENT"],
      [(o) => (notifications(o)[0]!.epoch = 2), "NOTIFICATION_EPOCH_INCONSISTENT"],
    ];
    for (const [mutate, code] of unretained) {
      const bad = copyOf(dd);
      reseal(bad, COL, mutate);
      const cb = collectorOf(bad);
      expect(cb.status, code).toBe("MISMATCH");
      expect(cb.findings, code).toContain(`MISMATCH:${code}`);
    }
    // One retained notification claiming the second accepted frame (its time and digest copied):
    // its position says sequence 1, but the second accepted frame is the second notification.
    const fewerDir = sealRun(fewer);
    const shifted = copyOf(fewerDir);
    reseal(shifted, COL, (o) => {
      const third = (get(o, "frameRecords", "value") as Record<string, unknown>[])[2]!;
      Object.assign(notifications(o)[0]!, {
        frameSequence: 3,
        receivedAtMs: third.receivedAtMs,
        frameSha256: third.sha256,
      });
    });
    expect(collectorOf(shifted).findings).toContain("MISMATCH:NOTIFICATION_SEQUENCE_INCONSISTENT");
  });
});
