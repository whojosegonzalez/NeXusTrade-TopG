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

// --- integration harness --------------------------------------------------------------------------

function env(limits: Partial<CpmmObservationRecorderLimits> = {}) {
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
    limits: COLLECTOR_LIMITS,
    commitment: "confirmed",
  });
  const f = fakeCtor({ autoPong: true });
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
      return recorder.recordTransport(w);
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
  o: { limits?: Partial<CpmmObservationRecorderLimits>; responder?: Responder } = {},
) {
  const e = env(o.limits);
  const p = e.owner.run();
  e.c.open();
  await e.to(OBS_START + 10);
  e.c.message(ackFrame());
  await flush();
  await e.to(RECEIVED_AT);
  e.script.push(o.responder ?? okTx(1));
  e.c.message(notif(1));
  await flush();
  await e.to(RECEIVED_AT + 3_000);
  e.c.message(notif(1));
  e.c.emit("ping", Buffer.from([9, 9]));
  await flush();
  await e.to(NOMINAL_END);
  e.c.message(unsubAck());
  await e.to(NOMINAL_END + 10);
  const report = await p;
  return { snapshot: e.finish(report), recorder: e.recorder, e, report };
}

function plan(recorderLimits: CpmmObservationRecorderLimits = RLIMITS) {
  return {
    kinds: {
      owner: "CPMM_POOL_CONNECTION_OWNER",
      wrapper: "CPMM_POOL_WEBSOCKET_TRANSPORT",
      recorder: "CPMM_POOL_OBSERVATION_RECORDER",
    },
    limits: {
      owner: { ...OWNER_LIMITS },
      wrapper: { ...WS_LIMITS },
      collector: { ...COLLECTOR_LIMITS },
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
): SealCpmmObservationInput {
  return {
    projectRoot: freshRoot(),
    runId: "run-1",
    snapshot,
    plan: plan(recorderLimits),
    componentVersions: { ...VERSIONS },
    poolContext: poolContext(),
    credentials: { urls: [...CREDENTIALS.urls], additional: [...CREDENTIALS.additional] },
    lateActivity: recorder === null ? null : { ...recorder.lateActivity() },
    ...over,
  };
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
    expect(v.rederivation).toEqual({ status: "NOT_IMPLEMENTED" });
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
        "RECORDS_MISSING:incoming",
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
    expect(va.rederivation).toEqual({ status: "NOT_ATTEMPTED" });
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
    const d = copyOf(r.outDir);
    reseal(d, CPMM_EVIDENCE_FILES.recording, (rec) => {
      (rec.retention as Record<string, unknown>).recorderRetentionComplete = true;
      (rec.instrumentation as Record<string, unknown>).complete = true;
    });
    reseal(d, CPMM_EVIDENCE_FILES.report, (rep) => {
      rep.recordedByRecorder = { recorderRetentionComplete: true, instrumentationComplete: true };
    });
    const v = verifyCpmmObservationEvidence(d);
    expect(v.integrity.ok).toBe(true);
    expect(v.retention.status).toBe("INCOMPLETE");
    expect(v.retention.reasons).toContain("PAYLOAD_OMITTED:transport-records.json");
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
      (rec.retention as Record<string, Record<string, number>>).exchanges!.observed = 0;
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
