/**
 * Roadmap step 3: synthetic offline tests of the CPMM observation run's composition core
 * (assessment §8.38.17 item 17 T).
 *
 * Every run composes the real accepted session, acquisition, adapter, tracker, ledger, collector,
 * owner, wrapper, recorder, fan-out and both sealers and verifiers, over a virtual clock, injected
 * timers, a scripted in-memory fetch and a fake `ws`-like client. Output goes to fresh temporary
 * directories, removed afterwards. No socket, request or real clock.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
import type { CpmmConnectionOwnerLimits } from "../candidate-scanner/CpmmPoolConnectionOwner.js";
import type { CpmmCollectorLimits } from "../candidate-scanner/CpmmPoolNotificationCollector.js";
import type { CpmmObservationRecorderLimits } from "../candidate-scanner/CpmmPoolObservationRecorder.js";
import type {
  CpmmPoolWebSocketTransportLimits,
  CpmmWsClientConstructor,
  CpmmWsClientEvent,
  CpmmWsClientLike,
  CpmmWsClientOptions,
} from "../candidate-scanner/CpmmPoolWebSocketTransport.js";
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";
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
import { verifyCpmmPoolAcquisitionEvidence } from "./cpmm-pool-acquisition-evidence.js";
import {
  CPMM_EVIDENCE_FALSE_FLAGS,
  CPMM_EVIDENCE_ROOT_SEGMENTS,
  verifyCpmmObservationEvidence,
} from "./cpmm-pool-observation-evidence.js";
import {
  CPMM_ACQUISITION_ROOT_SEGMENTS,
  CPMM_RUN_STOP_ABANDONED,
  CPMM_RUN_EVIDENCE_SCHEMA_VERSION,
  CPMM_RUN_STOP_FINISHED,
  CPMM_RUN_TRANSACTION_REQUEST,
  runCpmmPoolObservation,
  type CpmmObservationRunOptions,
  type CpmmObservationRunResult,
} from "./cpmm-pool-observation-run.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Built at runtime: a synthetic credential value, never a real one. */
const SECRET = ["synthetic", "run", "credential", "0123456789"].join("-");
const HOST = "rpc.example.test";
const RPC_URL = `https://${HOST}/?api-key=${SECRET}`;
const STREAM_URL = `wss://${HOST}/ws?api-key=${SECRET}`;
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
const LANES = {
  SOLANA_RPC: { maxAttempts: 8, pacingMs: 2_500, maxResponseBytes: 200_000 },
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
const limits = () => ({
  session: { lifetimeMs: 120_000, maxHttpAttempts: 8, requestTimeoutMs: 10_000, lanes: LANES },
  acquisition: { durationMs: 8_000, timeoutMs: 4_000, maxResponseBytes: 4_096 },
  owner: { ...OWNER_LIMITS },
  wrapper: { ...WS_LIMITS },
  collector: { ...COLLECTOR_LIMITS },
  ledger: { maxSignatureRecords: 16, maxDuplicateDetailsPerRecord: 4, maxEpochs: 4 },
  adapter: { maxTrackedSignatures: 32, maxResponseBytes: 100_000 },
  evidenceRecorder: { maxPendingEvidence: 8 },
  recorder: { ...RLIMITS },
  fanOut: { maxRetainedFailures: 8 },
});

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/** Runs `fn` after `n` chained microtasks, without waiting for any macrotask. */
const afterHops = (n: number, fn: () => void): void => {
  if (n === 0) fn();
  else queueMicrotask(() => afterHops(n - 1, fn));
};

const TMP = mkdtempSync(path.join(tmpdir(), "cpmm-run-test-"));
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
interface ClientScript {
  /** none: close() never closes (the socket stays open until terminated, and then still). */
  closeMode?: "sync" | "none";
}
class FakeClient implements CpmmWsClientLike {
  public readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  #rs = 0;
  #binaryType = "nodebuffer";
  constructor(
    public readonly address: string,
    public readonly options: CpmmWsClientOptions,
    public readonly s: ClientScript,
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
    const echo = Buffer.from(data);
    queueMicrotask(() => this.emit("pong", echo));
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
  message(data: unknown): void {
    this.emit("message", data, false);
  }
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
const ACCOUNT_SLOT = 300_000_000;

const vault = (mint: string, raw: bigint) =>
  createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: mint,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: raw,
    state: 1,
  });
const ACCOUNTS = [
  {
    address: FIXTURE_CPMM_POOL_ADDRESS,
    owner: RAYDIUM_CPMM_PROGRAM_ID,
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
  },
  {
    address: FIXTURE_CPMM_TOKEN_0_VAULT,
    owner: SPL_TOKEN_PROGRAM_ID,
    data: vault(CANDIDATE, 10_000_000_000n),
  },
  {
    address: FIXTURE_CPMM_TOKEN_1_VAULT,
    owner: SPL_TOKEN_PROGRAM_ID,
    data: vault(WSOL_MINT, 50_000_000_000n),
  },
];
const TARGET = { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE };
const POOL = (() => {
  const raw = (i: number) => ({
    address: ACCOUNTS[i]!.address,
    data: ACCOUNTS[i]!.data,
    ownerProgramId: ACCOUNTS[i]!.owner,
    slot: ACCOUNT_SLOT,
  });
  const r = adaptRaydiumCpmmPoolState({
    target: TARGET,
    poolAccount: raw(0),
    vault0Account: raw(1),
    vault1Account: raw(2),
  });
  if (!r.ok) throw new Error(`fixture refused: ${r.refusalCode}`);
  return r;
})();

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
/** The discovery request; the snapshot follows one lane pacing later, then observation starts. */
const T0 = OBS_START - 2_500;
const RECEIVED_AT = 1_794_829_421_500;
const NOMINAL_END = OBS_START + 30_000;
/** Past every owner, drain and cleanup deadline of a run starting at OBS_START. */
const AFTER_ALL = NOMINAL_END + 2_000 + 15_000 + 10;

function txResult(sig: string, top: Ix[] = [swapBuy()]): unknown {
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
      innerInstructions: top
        .map((t, index) => ({
          index,
          instructions: (t.children ?? []).map((c) => compile(c, 2)),
        }))
        .filter((g) => g.instructions.length > 0),
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

// --- the harness ---------------------------------------------------------------------------------

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}
type Responder = (req: RpcRequest, h: Harness) => Promise<Response> | Response | undefined;

function accountsResponse(req: RpcRequest, apiVersion = "2.0.0"): Response {
  const keys = req.params[0] as string[];
  return Response.json({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      context: { slot: ACCOUNT_SLOT, apiVersion },
      value: keys.map((address) => {
        const a = ACCOUNTS.find((entry) => entry.address === address)!;
        return {
          data: [a.data.toString("base64"), "base64"],
          owner: a.owner,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
          space: a.data.length,
        };
      }),
    },
  });
}
const txResponse = (req: RpcRequest) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: req.id, result: txResult(req.params[0] as string) }),
    { status: 200 },
  );

interface HarnessOptions {
  /** Per getMultipleAccounts call (1-based); undefined falls through to the fixture. */
  acquisition?: (
    n: number,
    req: RpcRequest,
    h: Harness,
  ) => Promise<Response> | Response | undefined;
  transaction?: Responder;
  client?: ClientScript;
  /** Runs inside the client constructor (before the wrapper returns). */
  onClient?: (h: Harness) => void;
  /** Replaces the client constructor. */
  ctor?: CpmmWsClientConstructor;
  /** Called by the injected setTimeout before the timer is queued. */
  onSchedule?: (ms: number, h: Harness) => void;
}

type Harness = ReturnType<typeof harness>;
function harness(o: HarnessOptions = {}) {
  const state = { now: T0 };
  let nextTimer = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const calls: RpcRequest[] = [];
  const instances: FakeClient[] = [];
  let acquisitionCalls = 0;
  const root = freshRoot();
  const h = {
    state,
    queue,
    calls,
    instances,
    root,
    get acquisitionCalls() {
      return acquisitionCalls;
    },
    get client(): FakeClient {
      return instances[0]!;
    },
    timers: undefined as unknown as PaperRequestSessionTimers,
    to: async (_t: number) => {
      void _t;
    },
    method: (m: string) => calls.filter((c) => c.method === m).length,
  };
  h.timers = {
    setTimeout: (fn, ms) => {
      o.onSchedule?.(ms, h as Harness);
      const id = ++nextTimer;
      queue.set(id, { at: state.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => {
      queue.delete(handle as number);
    },
  };
  h.to = async (t: number) => {
    for (;;) {
      await flush();
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
    await flush();
  };
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(req);
    if (req.method === "getMultipleAccounts") {
      const n = ++acquisitionCalls;
      return (await o.acquisition?.(n, req, h as Harness)) ?? accountsResponse(req);
    }
    if (req.method === "getTransaction")
      return (await o.transaction?.(req, h as Harness)) ?? txResponse(req);
    throw new Error("UNSCRIPTED_REQUEST");
  }) as unknown as typeof fetch;
  const script = o.client ?? {};
  const ctor =
    o.ctor ??
    (class extends FakeClient {
      constructor(address: string, options: CpmmWsClientOptions) {
        super(address, options, script);
        instances.push(this);
        o.onClient?.(h as Harness);
      }
    } as unknown as CpmmWsClientConstructor);
  const options = (over: Partial<Record<keyof CpmmObservationRunOptions, unknown>> = {}) =>
    ({
      projectRoot: root,
      runId: "run-1",
      target: { ...TARGET },
      endpoints: { rpcUrl: RPC_URL, streamUrl: STREAM_URL },
      secrets: [SECRET],
      fetchFn,
      webSocketClientConstructor: ctor,
      clock: () => state.now,
      timers: h.timers,
      componentVersions: { ...VERSIONS },
      epoch: 1,
      subscribeRequestId: SUB_REQ,
      unsubscribeRequestId: UNSUB_REQ,
      limits: limits(),
      ...over,
    }) as CpmmObservationRunOptions;
  return Object.assign(h, { options, fetchFn });
}

/** The client's side of a clean observation: ack, a resolved notification, a duplicate, a ping. */
async function observe(
  h: Harness,
  o: {
    second?: number;
    noUnsubscribeAck?: boolean;
    afterAck?: () => void | Promise<void>;
    afterFirst?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  await h.to(OBS_START + 10);
  expect(h.instances).toHaveLength(1);
  const c = h.client;
  c.open();
  await h.to(OBS_START + 20);
  c.message(ackFrame());
  await flush();
  await o.afterAck?.();
  await h.to(RECEIVED_AT);
  c.message(notif(1));
  await flush();
  await o.afterFirst?.();
  await h.to(RECEIVED_AT + 3_000);
  c.message(notif(o.second ?? 1));
  c.emit("ping", Buffer.from([9, 9]));
  await flush();
  await h.to(NOMINAL_END);
  if (!o.noUnsubscribeAck) c.message(unsubAck());
  await flush();
  await h.to(AFTER_ALL);
}

async function cleanRun(o: HarnessOptions = {}, over: Parameters<Harness["options"]>[0] = {}) {
  const h = harness(o);
  const pending = runCpmmPoolObservation(h.options(over));
  await observe(h);
  const r = await pending;
  await h.to(AFTER_ALL + 60_000);
  return { h, r };
}

function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listAll(abs).map((x) => `${name}/${x}`));
    else out.push(name);
  }
  return out.sort();
}
function expectNoCredential(root: string, r: CpmmObservationRunResult): void {
  for (const f of listAll(root)) {
    const text = readFileSync(path.join(root, ...f.split("/")), "utf8");
    expect(text.includes(SECRET), f).toBe(false);
    expect(text.includes("https://"), f).toBe(false);
    expect(text.includes("wss://"), f).toBe(false);
  }
  const json = JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
  expect(json.includes(SECRET)).toBe(false);
  expect(json.includes(HOST)).toBe(false);
}
const acquisitionDirOf = (root: string, runId = "run-1") =>
  path.join(root, ...CPMM_ACQUISITION_ROOT_SEGMENTS, runId);
const observationDirOf = (root: string, runId = "run-1") =>
  path.join(root, ...CPMM_EVIDENCE_ROOT_SEGMENTS, runId);

/** No client and no observation evidence; the acquisition evidence as given. */
function expectNotObserved(h: Harness, r: CpmmObservationRunResult): void {
  expect(h.instances).toHaveLength(0);
  expect(r.observation).toEqual({ started: false, transportFactoryCalls: 0, report: null });
  expect(r.recording.finished).toBe(false);
  expect(r.observationEvidence).toEqual({ seal: null, verification: null });
  expect(existsSync(observationDirOf(h.root))).toBe(false);
  expect(h.method("getTransaction")).toBe(0);
  expect(r.status).toBe("FAILED");
  expect(r.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
}

const shared = cleanRun();

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM observation run: composition core (item 17 T)", () => {
  it("RN1: a clean run acquires once, observes one connection, and seals two bound, verified bundles", async () => {
    const { h, r } = await shared;
    expect(r.firstFailure).toBeNull();
    expect(r.cleanupFailures).toEqual([]);
    expect(r.status).toBe("SUCCEEDED");
    expect(r.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    // One shared session: two acquisition requests, then one retrieval, on one paced lane.
    expect(h.calls.map((c) => c.method)).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getTransaction",
    ]);
    expect(h.calls.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(r.session).toEqual({
      stopReason: CPMM_RUN_STOP_FINISHED,
      httpAttempts: 3,
      acquisitionWindow: { start: 0, end: 2 },
      observationWindow: { start: 2, end: 3 },
    });
    expect(r.acquisition).toMatchObject({
      outcome: "ACQUIRED",
      code: "ACQUIRED",
      retainedExchanges: 2,
    });
    // One connection, made only after the acquisition was reproduced.
    expect(h.instances).toHaveLength(1);
    expect(h.client.address).toBe(STREAM_URL);
    expect(r.observation.started).toBe(true);
    expect(r.observation.transportFactoryCalls).toBe(1);
    expect(r.observation.report).toMatchObject({
      terminal: { cause: "OBSERVATION_COMPLETED" },
      connectionRunClean: true,
      cleanup: { status: "SETTLED" },
    });
    expect(r.observation.report!.deadlines!.startedAtMs).toBe(OBS_START);
    expect(r.recording.finished).toBe(true);
    // Acquisition evidence: sealed, reproduced, and the exact dependency of the observation.
    const acquisitionSeal = r.acquisitionEvidence.seal!;
    expect(acquisitionSeal).toMatchObject({ ok: true, outDir: acquisitionDirOf(h.root) });
    expect(r.acquisitionEvidence.verification).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUIRED_REPRODUCED",
    });
    const observationSeal = r.observationEvidence.seal!;
    expect(observationSeal).toMatchObject({ ok: true, outDir: observationDirOf(h.root) });
    const v = r.observationEvidence.verification!;
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.retention.status).toBe("COMPLETE");
    expect(v.poolContextProvenance).toBe("ACQUIRED_BOUND");
    expect(v.acquisitionProvenance).toBe("ACQUIRED_BOUND");
    const manifest = acquisitionSeal.ok ? acquisitionSeal.manifestSha256 : null;
    expect(v.acquisitionBinding).toMatchObject({
      status: "REPRODUCED",
      findings: [],
      expectedManifestSha256: manifest,
      manifestSha256: manifest,
    });
    expect(v.rederivation.components!.transactionAnalysis).toMatchObject({
      status: "REPRODUCED",
      analysis: "AVAILABLE",
      comparedExchanges: 1,
    });
    expect(v.rederivation.components!.runtimeAccounting.status).toBe(
      "RUNTIME_ACCOUNTING_NOT_REPRODUCED",
    );
    expect(v.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    // Independently re-verified from disk, with the same results.
    expect(verifyCpmmPoolAcquisitionEvidence(acquisitionDirOf(h.root))).toEqual(
      r.acquisitionEvidence.verification,
    );
    expect(
      verifyCpmmObservationEvidence(observationDirOf(h.root), {
        analysisSecrets: [RPC_URL, SECRET],
        acquisitionDir: acquisitionDirOf(h.root),
      }),
    ).toEqual(v);
    expectNoCredential(h.root, r);
    // Every injected timer was cleared or ran; the result cannot be changed afterwards.
    expect(h.queue.size).toBe(0);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.session)).toBe(true);
  });

  it("RN1b: inert source: no environment, real clock, network, sockets, console, CLI or file reads", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./cpmm-pool-observation-run.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:fs",
      "node:path",
      "node:util",
      "../candidate-scanner/CpmmPoolAccountAcquisition.js",
      "../candidate-scanner/CpmmPoolConnectionOwner.js",
      "../candidate-scanner/CpmmPoolNotificationCollector.js",
      "../candidate-scanner/CpmmPoolObservationRecorder.js",
      "../candidate-scanner/CpmmPoolWebSocketTransport.js",
      "../candidate-scanner/CpmmResolutionAccountingLedger.js",
      "../candidate-scanner/PaperRequestSession.js",
      "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js",
      "../candidate-scanner/RollingTradeFlowTracker.js",
      "./cpmm-pool-acquisition-evidence.js",
      "./cpmm-pool-observation-evidence.js",
    ]);
    for (const banned of [
      /\bprocess\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /\bglobalThis\b/,
      /(?<![.\w])(setTimeout|setInterval|setImmediate|clearTimeout)\s*\(/,
      /(?<![.\w])fetch\s*\(/,
      /\bconsole\b/,
      /\brequire\(/,
      /\bimport\(/,
      /node:(net|http|https|tls|dns|child_process|os|worker_threads)/,
      /from\s+"ws"/,
      /\bnew\s+WebSocket\b/,
      /import\.meta/,
      /\bargv\b/,
      /readFileSync|readdirSync|openSync/,
    ]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
    // The only file-system access is the setup check for existing output directories.
    expect([...code.matchAll(/\b(\w+Sync)\b/g)].map((m) => m[1])).toEqual([
      "existsSync",
      "existsSync",
    ]);
    // Flags and qualification are never set true anywhere.
    expect(code).not.toMatch(/:\s*true\s+as\s+const|Eligible:\s*true|Established:\s*true/);
  });

  it("RN2: setup refusals construct nothing, request nothing and write nothing", async () => {
    const getterCalls: string[] = [];
    const withGetter = {
      candidateMint: CANDIDATE,
      get poolAddress() {
        getterCalls.push("poolAddress");
        return FIXTURE_CPMM_POOL_ADDRESS;
      },
    };
    const l = limits;
    const cases: [string, (root: string) => Parameters<Harness["options"]>[0], string][] = [
      ["extra option", () => ({ extra: 1 }) as never, "OPTIONS_INVALID"],
      ["target getter", () => ({ target: withGetter }), "TARGET_INVALID"],
      ["relative root", () => ({ projectRoot: "relative/root" }), "PROJECT_ROOT_INVALID"],
      ["run id", () => ({ runId: "run.1" }), "RUN_ID_INVALID"],
      [
        "plain http",
        () => ({ endpoints: { rpcUrl: "http://rpc.example.test/", streamUrl: STREAM_URL } }),
        "ENDPOINTS_INVALID",
      ],
      ["short secret", () => ({ secrets: ["abc"] }), "SECRETS_INVALID"],
      [
        "component versions",
        () => ({ componentVersions: { ...VERSIONS, owner: "HEAD" } }),
        "COMPONENT_VERSIONS_INVALID",
      ],
      ["same request ids", () => ({ unsubscribeRequestId: SUB_REQ }), "REQUEST_IDS_INVALID"],
      [
        "lifetime too short for acquisition, observation, drain and cleanup",
        () => ({ limits: { ...l(), session: { ...l().session, lifetimeMs: 8_000 + 47_000 - 1 } } }),
        "LIMITS_INVALID:SESSION_LIFETIME",
      ],
      [
        "session attempt ceiling below its own lane's allowance",
        () => ({ limits: { ...l(), session: { ...l().session, maxHttpAttempts: 2 } } }),
        "LIMITS_INVALID:SESSION",
      ],
      [
        "lane attempts below acquisition plus one retrieval",
        () => ({
          limits: {
            ...l(),
            session: {
              ...l().session,
              lanes: { ...LANES, SOLANA_RPC: { ...LANES.SOLANA_RPC, maxAttempts: 2 } },
            },
          },
        }),
        "LIMITS_INVALID:ATTEMPTS",
      ],
      [
        "another provider lane enabled",
        () => ({
          limits: {
            ...l(),
            session: {
              ...l().session,
              lanes: { ...LANES, RUGCHECK: { ...LANES.RUGCHECK, maxAttempts: 1 } },
            },
          },
        }),
        "LIMITS_INVALID:OTHER_LANES_ENABLED",
      ],
      [
        "acquisition longer than its ceiling",
        () => ({ limits: { ...l(), acquisition: { ...l().acquisition, durationMs: 30_001 } } }),
        "LIMITS_INVALID:ACQUISITION",
      ],
      [
        "acquisition timeout beyond the session's",
        () => ({
          limits: {
            ...l(),
            session: { ...l().session, requestTimeoutMs: 3_999 },
          },
        }),
        "LIMITS_INVALID:ACQUISITION",
      ],
      [
        "wrapper frame limit differs from the collector's",
        () => ({ limits: { ...l(), wrapper: { ...WS_LIMITS, maxFrameBytes: FRAME_BYTES + 1 } } }),
        "LIMITS_INVALID:FRAME_BYTES",
      ],
      [
        "handshake not below the acknowledgement timeout",
        () => ({ limits: { ...l(), wrapper: { ...WS_LIMITS, handshakeTimeoutMs: 5_000 } } }),
        "LIMITS_INVALID:HANDSHAKE",
      ],
      [
        "exchange allowance below outstanding resolutions",
        () => ({ limits: { ...l(), recorder: { ...RLIMITS, maxExchangeBodyBytes: 799_999 } } }),
        "LIMITS_INVALID:RECORDER_EXCHANGES",
      ],
      [
        "owner relations",
        () => ({ limits: { ...l(), owner: { ...OWNER_LIMITS, maxPings: 2 } } }),
        "LIMITS_INVALID:OWNER",
      ],
      [
        "a recorder limit the recorder itself refuses",
        () => ({ limits: { ...l(), recorder: { ...RLIMITS, maxPayloadBytesPerRecord: 0 } } }),
        "COMPOSITION_FAILED",
      ],
      [
        "existing observation output",
        (root) => {
          mkdirSync(observationDirOf(root), { recursive: true });
          return {};
        },
        "OUTPUT_EXISTS:OBSERVATION",
      ],
      [
        "existing acquisition output",
        (root) => {
          mkdirSync(acquisitionDirOf(root), { recursive: true });
          return {};
        },
        "OUTPUT_EXISTS:ACQUISITION",
      ],
      ["aborted signal", () => ({ signal: AbortSignal.abort() }), "CANCELLED_BEFORE_START"],
      ["foreign signal", () => ({ signal: { aborted: false } }), "SIGNAL_INVALID"],
    ];
    for (const [label, over, code] of cases) {
      const h = harness();
      const before = listAll(h.root);
      const r = await runCpmmPoolObservation(h.options(over(h.root)));
      expect(r.firstFailure, label).toEqual({ stage: "SETUP", code });
      expect(r.status, label).toBe("FAILED");
      expect(h.calls, label).toHaveLength(0);
      expect(h.instances, label).toHaveLength(0);
      expect(h.queue.size, label).toBe(0);
      expect(r.acquisition, label).toBeNull();
      expect(r.acquisitionEvidence, label).toEqual({ seal: null, verification: null });
      expect(r.session.httpAttempts, label).toBe(0);
      expect(listAll(h.root), label).toEqual(before);
    }
    expect(getterCalls).toEqual([]);
  });

  it("RN3: acquisition refusals keep their truthful evidence and never construct a client", async () => {
    // An RPC error at discovery: one request, sealed as a failure.
    const rpc = harness({
      acquisition: (_n, req) =>
        Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "x" } }),
    });
    const r1 = await runCpmmPoolObservation(rpc.options());
    expect(r1.firstFailure).toEqual({ stage: "ACQUISITION", code: "RPC_ERROR" });
    expect(r1.acquisition).toMatchObject({ outcome: "ACQUISITION_FAILED", stage: "DISCOVERY" });
    expect(rpc.calls).toHaveLength(1);
    expect(r1.acquisitionEvidence.seal).toMatchObject({ ok: true });
    expect(r1.acquisitionEvidence.verification).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUISITION_FAILED",
    });
    expect(r1.session.stopReason).toBe(CPMM_RUN_STOP_ABANDONED);
    expectNotObserved(rpc, r1);

    // A 429 at the snapshot stops the shared session; the session's own cause is kept.
    const limited = harness({
      acquisition: (n) => (n === 2 ? new Response("{}", { status: 429 }) : undefined),
    });
    const pending = runCpmmPoolObservation(limited.options());
    await limited.to(OBS_START + 10_000);
    const r2 = await pending;
    expect(r2.firstFailure).toEqual({ stage: "ACQUISITION", code: "HTTP_429_RECEIVED" });
    expect(r2.acquisition).toMatchObject({
      sessionStopReason: "HTTP_429_RECEIVED",
      stage: "SNAPSHOT",
    });
    expect(r2.session.stopReason).toBe("HTTP_429_RECEIVED");
    expect(limited.calls).toHaveLength(2);
    expectNotObserved(limited, r2);

    // The adapter refuses the acquired context (the target's mint is not in this pool).
    const refused = harness();
    const pending3 = runCpmmPoolObservation(
      refused.options({
        target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: key(42) },
      }),
    );
    await refused.to(OBS_START + 10_000);
    const r3 = await pending3;
    expect(r3.acquisition!.outcome).toBe("ACQUIRED_CONTEXT_REFUSED");
    expect(r3.firstFailure).toEqual({ stage: "ACQUISITION", code: r3.acquisition!.code });
    expect(r3.acquisitionEvidence.verification).toMatchObject({
      computed: "ACQUIRED_CONTEXT_REFUSED",
    });
    expectNotObserved(refused, r3);
    for (const [h, r] of [
      [rpc, r1],
      [limited, r2],
      [refused, r3],
    ] as const) {
      expectNoCredential(h.root, r);
      expect(h.queue.size).toBe(0);
    }
  });

  it("RN4: a failed acquisition seal or a limited acquisition refuses observation", async () => {
    // The acquisition directory appears while the snapshot is in flight: the seal is refused.
    const raced = harness({
      acquisition: (n, _req, h) => {
        if (n === 2) mkdirSync(acquisitionDirOf(h.root), { recursive: true });
        return undefined;
      },
    });
    const p1 = runCpmmPoolObservation(raced.options());
    await raced.to(OBS_START + 10_000);
    const r1 = await p1;
    expect(r1.acquisition!.outcome).toBe("ACQUIRED");
    expect(r1.firstFailure).toEqual({
      stage: "ACQUISITION_EVIDENCE",
      code: "SEAL_FAILED:OUTPUT_EXISTS",
    });
    expect(r1.acquisitionEvidence.verification).toBeNull();
    expect(readdirSync(acquisitionDirOf(raced.root))).toEqual([]);
    expectNotObserved(raced, r1);

    // A credential in the snapshot's context is redacted: sealed, but only ACQUIRED_LIMITED.
    const redacted = harness({
      acquisition: (n, req) => (n === 2 ? accountsResponse(req, SECRET) : undefined),
    });
    const p2 = runCpmmPoolObservation(redacted.options());
    await redacted.to(OBS_START + 10_000);
    const r2 = await p2;
    expect(r2.acquisition!.outcome).toBe("ACQUIRED");
    expect(r2.acquisitionEvidence.seal).toMatchObject({ ok: true });
    expect(r2.acquisitionEvidence.verification).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUIRED_LIMITED",
    });
    expect(r2.firstFailure).toEqual({
      stage: "ACQUISITION_EVIDENCE",
      code: "NOT_REPRODUCED:ACQUIRED_LIMITED",
    });
    expectNotObserved(redacted, r2);
    expectNoCredential(redacted.root, r2);
  });

  it("RN5: the shared budget is never reset: an exhausted session refuses the next retrieval", async () => {
    const tight = {
      ...limits(),
      session: {
        ...limits().session,
        maxHttpAttempts: 3,
        lanes: { ...LANES, SOLANA_RPC: { ...LANES.SOLANA_RPC, maxAttempts: 3 } },
      },
    };
    const h = harness();
    const pending = runCpmmPoolObservation(h.options({ limits: tight }));
    await observe(h, { second: 2 });
    const r = await pending;
    // Two acquisition requests and one retrieval; the second signature's request was refused.
    expect(h.calls.map((c) => c.method)).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getTransaction",
    ]);
    expect(r.session.httpAttempts).toBe(3);
    expect(r.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(r.observationEvidence.verification!.acquisitionBinding!.status).toBe("REPRODUCED");
    const ledgerRecords = JSON.parse(
      readFileSync(path.join(observationDirOf(h.root), "ledger.json"), "utf8"),
    ) as { records: { value: { signature: string; state: string }[] } };
    const second = ledgerRecords.records.value.find((x) => x.signature === signatureOf(2));
    expect(second).toBeDefined();
    expect(r.status === "SUCCEEDED").toBe(r.observation.report!.connectionRunClean);
  });

  it("RN6: cancellation during acquisition, at the stage boundary and during observation", async () => {
    // During acquisition: the caller cancels while discovery is in flight.
    const c1 = new AbortController();
    const during = harness({
      acquisition: (n) => {
        if (n === 1) c1.abort();
        return undefined;
      },
    });
    const p1 = runCpmmPoolObservation(during.options({ signal: c1.signal }));
    await during.to(OBS_START + 10_000);
    const r1 = await p1;
    expect(r1.firstFailure!.stage).toBe("ACQUISITION");
    expect(r1.firstFailure!.code).toMatch(/^CALLER_CANCELLED/);
    expect(r1.finalizationCancelled).toBe(false);
    expect(r1.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUISITION_FAILED" });
    expect(during.calls).toHaveLength(1);
    expectNotObserved(during, r1);

    // At the stage boundary: after a reproduced acquisition, before any client exists.
    const c2 = new AbortController();
    const boundary = harness({
      onSchedule: (ms, h) => {
        if (ms === 0 && h.acquisitionCalls === 2) c2.abort();
      },
    });
    const p2 = runCpmmPoolObservation(boundary.options({ signal: c2.signal }));
    await boundary.to(OBS_START + 10_000);
    const r2 = await p2;
    expect(r2.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUIRED_REPRODUCED" });
    expect(r2.firstFailure).toEqual({ stage: "STAGE_BOUNDARY", code: "CANCELLED" });
    expect(r2.finalizationCancelled).toBe(false);
    expect(r2.session.stopReason).toBe(CPMM_RUN_STOP_ABANDONED);
    expectNotObserved(boundary, r2);

    // During observation, with a retrieval in flight whose response arrives after the run ended.
    const c3 = new AbortController();
    let release: (() => void) | undefined;
    const late = harness({
      transaction: (req) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(txResponse(req));
        }),
    });
    const p3 = runCpmmPoolObservation(late.options({ signal: c3.signal }));
    await observe(late, {
      afterFirst: async () => {
        await late.to(RECEIVED_AT + 100);
        expect(late.method("getTransaction")).toBe(1);
        c3.abort();
      },
    });
    const r3 = await p3;
    const before = JSON.stringify(r3, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    expect(r3.observation.report!.terminal.cause).toBe("CANCELLED");
    expect(r3.firstFailure!).toMatchObject({ stage: "OBSERVATION" });
    expect(r3.firstFailure!.code).toMatch(/^CANCELLED/);
    // The owner already reported this cancellation; finalization was not cancelled separately.
    expect(r3.finalizationCancelled).toBe(false);
    // Partial evidence is still sealed, verified and bound.
    expect(r3.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(r3.observationEvidence.verification!.acquisitionBinding!.status).toBe("REPRODUCED");
    release!();
    await flush();
    await late.to(AFTER_ALL + 60_000);
    expect(JSON.stringify(r3, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v))).toBe(
      before,
    );
    expect(r3.status).toBe("FAILED");
    expect(late.method("getTransaction")).toBe(1);
  });

  it("RN6b: a session stop during observation reaches the owner, and the session's cause is kept", async () => {
    const h = harness({ transaction: () => new Response("{}", { status: 429 }) });
    const pending = runCpmmPoolObservation(h.options());
    await observe(h);
    const r = await pending;
    expect(r.session.stopReason).toBe("HTTP_429_RECEIVED");
    expect(r.observation.report!.terminal.cause).toBe("SESSION_STOPPED");
    expect(r.firstFailure!.stage).toBe("OBSERVATION");
    expect(r.firstFailure!.code).toMatch(/^SESSION_STOPPED/);
    expect(r.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(h.method("getTransaction")).toBe(1);
  });

  it("RN7: deadlines: the acquisition's deadline before the snapshot, and the unsubscribe intake deadline", async () => {
    // Discovery answers late: the snapshot's full timeout no longer fits before the deadline.
    const slow = harness({
      acquisition: (n, req, h) =>
        n === 1
          ? new Promise<Response>((resolve) => {
              h.timers.setTimeout(() => resolve(accountsResponse(req)), 4_500);
            })
          : undefined,
    });
    // The request timeout clears the slow discovery, but then cannot fit before the deadline.
    const p1 = runCpmmPoolObservation(
      slow.options({
        limits: {
          ...limits(),
          acquisition: { durationMs: 8_000, timeoutMs: 5_000, maxResponseBytes: 4_096 },
        },
      }),
    );
    await slow.to(OBS_START + 20_000);
    const r1 = await p1;
    expect(r1.firstFailure).toEqual({
      stage: "ACQUISITION",
      code: "ACQUISITION_DEADLINE_EXCEEDED",
    });
    expect(slow.calls).toHaveLength(1);
    expectNotObserved(slow, r1);

    // No unsubscribe acknowledgement: intake ends at its deadline; the run is not clean.
    const h = harness();
    const p2 = runCpmmPoolObservation(h.options());
    await observe(h, { noUnsubscribeAck: true });
    const r2 = await p2;
    expect(r2.observation.report).toMatchObject({
      terminal: { cause: "OBSERVATION_COMPLETED" },
      intake: { trigger: "INTAKE_DEADLINE" },
      connectionRunClean: false,
    });
    expect(r2.firstFailure).toEqual({ stage: "OBSERVATION", code: "CONNECTION_RUN_NOT_CLEAN" });
    expect(r2.cleanupFailures).toEqual([]);
    expect(r2.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(r2.observationEvidence.verification!.acquisitionBinding!.status).toBe("REPRODUCED");
  });

  it("RN8: transport failure and failed cleanup stay explicit; one connection, never a second", async () => {
    // A client error before open.
    const errored = harness();
    const p1 = runCpmmPoolObservation(errored.options());
    await errored.to(OBS_START + 10);
    errored.client.emit("error", new Error("connect ECONNREFUSED"));
    await errored.to(AFTER_ALL);
    const r1 = await p1;
    expect(r1.observation.report!.terminal.cause).toBe("TRANSPORT_ERROR");
    expect(r1.firstFailure!.code).toMatch(/^TRANSPORT_ERROR/);
    expect(r1.observation.transportFactoryCalls).toBe(1);
    expect(errored.instances).toHaveLength(1);
    expect(errored.method("getTransaction")).toBe(0);
    expect(r1.observationEvidence.verification!.integrity.ok).toBe(true);

    // A client constructor that throws.
    const thrower = harness({
      ctor: class {
        constructor() {
          throw new Error("constructor failed");
        }
      } as unknown as CpmmWsClientConstructor,
    });
    const p2 = runCpmmPoolObservation(thrower.options());
    await thrower.to(AFTER_ALL);
    const r2 = await p2;
    expect(r2.observation.transportFactoryCalls).toBe(1);
    expect(r2.firstFailure!.stage).toBe("OBSERVATION");
    expect(r2.observation.report!.terminal.cause).not.toBe("OBSERVATION_COMPLETED");
    expect(r2.observationEvidence.verification!.integrity.ok).toBe(true);

    // The socket never closes: cleanup fails, the completed cause is kept, and the run fails.
    const stuck = harness({ client: { closeMode: "none" } });
    const p3 = runCpmmPoolObservation(stuck.options());
    await observe(stuck);
    const r3 = await p3;
    expect(r3.observation.report).toMatchObject({
      terminal: { cause: "OBSERVATION_COMPLETED" },
      cleanup: { status: "FAILED_STILL_OPEN" },
    });
    expect(r3.firstFailure).toBeNull();
    expect(r3.cleanupFailures).toEqual(["OWNER_CLEANUP:FAILED_STILL_OPEN"]);
    expect(r3.status).toBe("FAILED");
    expect(r3.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(r3.observationEvidence.verification!.acquisitionBinding!.status).toBe("REPRODUCED");
  });

  it("RN9: an observation sealing failure keeps the acquisition bundle and the failure code", async () => {
    const h = harness({
      onClient: (x) => mkdirSync(observationDirOf(x.root), { recursive: true }),
    });
    const pending = runCpmmPoolObservation(h.options());
    await observe(h);
    const r = await pending;
    expect(r.observation.report!.connectionRunClean).toBe(true);
    expect(r.firstFailure).toEqual({
      stage: "OBSERVATION_EVIDENCE",
      code: "SEAL_FAILED:OUTPUT_DIRECTORY_EXISTS",
    });
    expect(r.observationEvidence.verification).toBeNull();
    expect(readdirSync(observationDirOf(h.root))).toEqual([]);
    expect(r.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUIRED_REPRODUCED" });
    expect(verifyCpmmPoolAcquisitionEvidence(acquisitionDirOf(h.root)).computed).toBe(
      "ACQUIRED_REPRODUCED",
    );
    expect(r.status).toBe("FAILED");
  });

  it.each(["synchronous", "queued"] as const)(
    "RN11: %s cancellation from the session lifetime clear preserves the completed observation",
    async (when) => {
      const controller = new AbortController();
      const h = harness();
      const { clearTimeout } = h.timers;
      h.timers.clearTimeout = (handle) => {
        clearTimeout(handle);
        if (handle !== 1) return;
        const cancel = () => controller.abort(new Error(SECRET));
        if (when === "queued") queueMicrotask(cancel);
        else cancel();
      };
      const pending = runCpmmPoolObservation(h.options({ signal: controller.signal }));
      await observe(h);
      const r = await pending;
      expect(controller.signal.aborted).toBe(true);
      expect(r).toMatchObject({
        status: "FAILED",
        firstFailure: { stage: "FINALIZATION", code: "CANCELLED" },
        finalizationCancelled: true,
        clockFailure: null,
        cleanupFailures: [],
        observation: {
          report: { terminal: { cause: "OBSERVATION_COMPLETED" }, connectionRunClean: true },
        },
        recording: { finished: true },
        observationEvidence: {
          verification: { integrity: { ok: true }, acquisitionBinding: { status: "REPRODUCED" } },
        },
        flags: CPMM_EVIDENCE_FALSE_FLAGS,
      });
      expect(h.queue.size).toBe(0);
      expectNoCredential(h.root, r);
    },
  );

  it("RN12: a cross-stage regression within the acquisition interval refuses observation", async () => {
    const beforeRegression: number[] = [];
    const h = harness({
      onSchedule: (ms, x) => {
        if (ms === 0 && x.acquisitionCalls === 2) {
          beforeRegression.push(x.state.now);
          x.state.now = T0 + 1_000;
        }
      },
    });
    const pending = runCpmmPoolObservation(h.options());
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(beforeRegression).toEqual([T0 + 2_500]);
    expect(r.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUIRED_REPRODUCED" });
    expect(r.firstFailure).toEqual({ stage: "STAGE_BOUNDARY", code: "CLOCK_REGRESSED" });
    expect(r.clockFailure).toEqual(r.firstFailure);
    expect(r.cleanupFailures).toEqual([]);
    expect(h.queue.size).toBe(0);
    expectNotObserved(h, r);
  });

  it("RN13: a clock that throws after session opening resolves and clears the timer", async () => {
    const h = harness();
    const faults: number[] = [];
    const clock = () => {
      if (h.queue.size > 0 && h.calls.length === 0) {
        faults.push(h.queue.size);
        throw new Error(SECRET);
      }
      return h.state.now;
    };
    const r = await runCpmmPoolObservation(h.options({ clock }));
    // The clock also throws from stop(), before the lifetime timer has been cleared.
    expect(faults.length).toBeGreaterThanOrEqual(2);
    expect(r.firstFailure).toEqual({ stage: "SETUP", code: "CLOCK_THREW" });
    expect(r.clockFailure).toEqual(r.firstFailure);
    expect(r.cleanupFailures).toEqual([]);
    expect(r.session.stopReason).toBe(CPMM_RUN_STOP_ABANDONED);
    expect(h.queue.size).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(listAll(h.root)).toEqual([]);
    expectNotObserved(h, r);
    expectNoCredential(h.root, r);
  });

  it.each(["CLOCK_INVALID", "CLOCK_REGRESSED", "CLOCK_THREW"] as const)(
    "RN14: final cleanup latches a one-read %s even though the owner completed",
    async (code) => {
      const h = harness();
      let injectFault = false;
      const { clearTimeout } = h.timers;
      h.timers.clearTimeout = (handle) => {
        clearTimeout(handle);
        if (handle === 1) injectFault = true;
      };
      const clock = () => {
        if (!injectFault) return h.state.now;
        injectFault = false;
        if (code === "CLOCK_THREW") throw new Error(SECRET);
        return code === "CLOCK_INVALID" ? Number.NaN : h.state.now - 1;
      };
      const pending = runCpmmPoolObservation(h.options({ clock }));
      await observe(h);
      const r = await pending;
      expect(injectFault).toBe(false);
      expect(r).toMatchObject({
        status: "FAILED",
        firstFailure: { stage: "FINALIZATION", code },
        clockFailure: { stage: "FINALIZATION", code },
        finalizationCancelled: false,
        cleanupFailures: [],
        observation: {
          report: { terminal: { cause: "OBSERVATION_COMPLETED" }, connectionRunClean: true },
        },
        observationEvidence: {
          verification: { integrity: { ok: true }, acquisitionBinding: { status: "REPRODUCED" } },
        },
        flags: CPMM_EVIDENCE_FALSE_FLAGS,
      });
      expect(h.queue.size).toBe(0);
      expectNoCredential(h.root, r);
    },
  );

  it("RN15: earlier observation failure wins over cancellation, a clock fault and a failed timer clear", async () => {
    const controller = new AbortController();
    const h = harness();
    const { clearTimeout } = h.timers;
    h.timers.clearTimeout = (handle) => {
      clearTimeout(handle);
      if (handle === 1) {
        controller.abort();
        throw new Error(SECRET);
      }
    };
    const pending = runCpmmPoolObservation(
      h.options({
        signal: controller.signal,
        clock: () => (controller.signal.aborted ? NaN : h.state.now),
      }),
    );
    await h.to(OBS_START + 10);
    h.client.emit("error", new Error("offline test transport failure"));
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(r.firstFailure).toMatchObject({
      stage: "OBSERVATION",
      code: expect.stringMatching(/^TRANSPORT_ERROR/),
    });
    expect(r.observation.report!.terminal.cause).toBe("TRANSPORT_ERROR");
    expect(r.status).toBe("FAILED");
    expect(r.finalizationCancelled).toBe(true);
    expect(r.clockFailure).toEqual({ stage: "FINALIZATION", code: "CLOCK_INVALID" });
    expect(r.cleanupFailures).toEqual(["SESSION_TIMER_CLEAR_FAILED"]);
    expect(r.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(h.queue.size).toBe(0);
    expect(r.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expectNoCredential(h.root, r);
  });

  it("RN16: harmless cleanup and equal clock readings preserve success", async () => {
    const h = harness();
    const { clearTimeout } = h.timers;
    const cleanupReadings: number[] = [];
    let clearingLifetime = false;
    h.timers.clearTimeout = (handle) => {
      clearTimeout(handle);
      if (handle === 1) {
        clearingLifetime = true;
        cleanupReadings.push(h.state.now);
      }
    };
    const clock = () => {
      if (clearingLifetime) cleanupReadings.push(h.state.now);
      return h.state.now;
    };
    const pending = runCpmmPoolObservation(
      h.options({ clock, signal: new AbortController().signal }),
    );
    await observe(h);
    const r = await pending;
    // Cleanup may read the clock any number of times; equal readings are never a regression.
    expect(cleanupReadings.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cleanupReadings).size).toBe(1);
    expect(r).toMatchObject({
      status: "SUCCEEDED",
      firstFailure: null,
      clockFailure: null,
      finalizationCancelled: false,
      cleanupFailures: [],
      flags: CPMM_EVIDENCE_FALSE_FLAGS,
    });
    expect(h.queue.size).toBe(0);
  });

  it("RN17: a permanent clock exception aborts in-flight work and bounds stuck owner cleanup", async () => {
    let clockBroken = false;
    let signal: AbortSignal | null | undefined;
    const h = harness({
      client: { closeMode: "none" },
      transaction: () => new Promise<Response>(() => {}),
    });
    const pending = runCpmmPoolObservation(
      h.options({
        clock: () => {
          if (clockBroken) throw new Error(SECRET);
          return h.state.now;
        },
        fetchFn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (String(init?.body).includes("getTransaction")) signal = init?.signal;
          return h.fetchFn(url, init);
        },
      }),
    );
    await h.to(OBS_START + 10);
    h.client.open();
    await h.to(OBS_START + 20);
    h.client.message(ackFrame());
    await h.to(RECEIVED_AT);
    h.client.message(notif(1));
    await flush();
    expect(h.method("getTransaction")).toBe(1);
    expect(signal?.aborted).toBe(false);
    clockBroken = true;
    h.client.message(notif(2));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(h.method("getTransaction")).toBe(1);
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(signal?.aborted).toBe(true);
    expect(r.firstFailure).toEqual({ stage: "OBSERVATION", code: "CLOCK_THREW" });
    expect(r.clockFailure).toEqual(r.firstFailure);
    expect(r.status).toBe("FAILED");
    expect(r.cleanupFailures).toEqual(["OWNER_CLEANUP:FAILED_STILL_OPEN"]);
    expect(r.recording.finished).toBe(true);
    expect(r.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(h.queue.size).toBe(0);
    expect(r.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expectNoCredential(h.root, r);
  });

  it("RN10: missing, altered and different dependencies never bind; a relocated exact copy does", async () => {
    const { h, r } = await shared;
    const dir = observationDirOf(h.root);
    const acquisitionDir = acquisitionDirOf(h.root);
    const verify = (acquisition?: string) =>
      verifyCpmmObservationEvidence(dir, {
        analysisSecrets: [RPC_URL, SECRET],
        ...(acquisition === undefined ? {} : { acquisitionDir: acquisition }),
      });
    // Relocated byte for byte: the dependency is its manifest digest, not its absolute path. The
    // bundle keeps its run-id directory name, which the manifest pins.
    const parent = path.join(TMP, `moved-${++dirCounter}`);
    mkdirSync(parent);
    const moved = path.join(parent, path.basename(acquisitionDir));
    cpSync(acquisitionDir, moved, { recursive: true });
    expect(verify(moved).acquisitionBinding!.status).toBe("REPRODUCED");
    // Not supplied.
    const none = verify();
    expect(none.integrity.ok).toBe(true);
    expect(none.acquisitionBinding!.status).toBe("MISSING_EVIDENCE");
    expect(none.poolContextProvenance).toBeNull();
    // Missing on disk.
    const missing = verify(path.join(TMP, "no-such-acquisition"));
    expect(missing.acquisitionBinding!.status).not.toBe("REPRODUCED");
    expect(missing.poolContextProvenance).toBeNull();
    // Altered: one byte of a listed file.
    const altered = path.join(TMP, `altered-${++dirCounter}`);
    cpSync(acquisitionDir, altered, { recursive: true });
    const file = path.join(altered, "accounts.json");
    const bytes = readFileSync(file);
    const last = bytes.length - 2;
    bytes[last] = bytes[last]! ^ 1;
    writeFileSync(file, bytes);
    const changed = verify(altered);
    expect(changed.integrity.ok).toBe(true);
    expect(changed.acquisitionBinding!.status).toBe("MISMATCH");
    expect(changed.poolContextProvenance).toBeNull();
    // A different, genuine acquisition of the same pool (another run id): another manifest digest.
    const other = await cleanRun({}, { runId: "run-2" });
    expect(other.r.status).toBe("SUCCEEDED");
    const different = verify(acquisitionDirOf(other.h.root, "run-2"));
    expect(different.acquisitionBinding!.status).toBe("MISMATCH");
    expect(different.acquisitionBinding!.findings).toContain(
      "MISMATCH:ACQUISITION_MANIFEST_DIGEST",
    );
    // The run's own result is unaffected by any of this.
    expect(r.status).toBe("SUCCEEDED");
  });

  it("RN18: an acquisition refusal still clears the lifetime timer and preserves its first failure", async () => {
    const controller = new AbortController();
    const h = harness({
      acquisition: (_n, req) =>
        Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "x" } }),
    });
    const { clearTimeout } = h.timers;
    h.timers.clearTimeout = (handle) => {
      clearTimeout(handle);
      if (handle === 1) controller.abort();
    };
    const r = await runCpmmPoolObservation(h.options({ signal: controller.signal }));
    expect(r.firstFailure).toEqual({ stage: "ACQUISITION", code: "RPC_ERROR" });
    expect(r.finalizationCancelled).toBe(true);
    expect(r.cleanupFailures).toEqual([]);
    expect(r.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUISITION_FAILED" });
    expect(r.session.stopReason).toBe(CPMM_RUN_STOP_ABANDONED);
    expect(h.queue.size).toBe(0);
    expectNotObserved(h, r);
  });

  it("RN19: the clock can recover after a request without clearing the acquisition-stage refusal", async () => {
    const h = harness();
    let injectFault = false;
    let recovered = false;
    let readFault = false;
    const { clearTimeout } = h.timers;
    h.timers.clearTimeout = (handle) => {
      clearTimeout(handle);
      if (handle !== 1 && h.calls.length === 1 && !readFault) injectFault = true;
    };
    const clock = () => {
      if (injectFault) {
        injectFault = false;
        readFault = true;
        return NaN;
      }
      if (readFault) recovered = true;
      return h.state.now;
    };
    const pending = runCpmmPoolObservation(h.options({ clock }));
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(recovered).toBe(true);
    expect(r.firstFailure).toEqual({ stage: "ACQUISITION", code: "CLOCK_INVALID" });
    expect(r.clockFailure).toEqual(r.firstFailure);
    expect(h.calls).toHaveLength(1);
    expect(r.acquisitionEvidence.verification?.integrity).toBe("VERIFIED");
    expect(r.cleanupFailures).toEqual([]);
    expect(h.queue.size).toBe(0);
    expectNotObserved(h, r);
  });

  it("RN20: a clock fault at dispatch does not reach the injected fetch", async () => {
    let schedulingAcquisition = false;
    let reads = 0;
    const h = harness({
      onSchedule: (ms) => {
        if (ms === limits().acquisition.durationMs) schedulingAcquisition = true;
      },
    });
    const clock = () => {
      // After scheduling the acquisition deadline: its initial request check, the
      // session's two refusal checks, then the session's dispatch timestamp.
      if (schedulingAcquisition && ++reads === 4) return NaN;
      return h.state.now;
    };
    const r = await runCpmmPoolObservation(h.options({ clock }));
    expect(r.firstFailure).toEqual({ stage: "ACQUISITION", code: "CLOCK_INVALID" });
    expect(r.session.httpAttempts).toBe(1); // the session reserved the dispatch
    expect(h.calls).toHaveLength(0); // but the injected fetch was never called
    expect(h.queue.size).toBe(0);
    expectNotObserved(h, r);
  });

  it("RN21: a clock fault on owner start does not reach the client constructor", async () => {
    let atBoundary = false;
    let reads = 0;
    const h = harness({
      onSchedule: (ms, x) => {
        if (ms === 0 && x.acquisitionCalls === 2) atBoundary = true;
      },
    });
    const clock = () => {
      // The transition check passes. The owner's first clock read fails.
      if (atBoundary && ++reads === 2) throw new Error(SECRET);
      return h.state.now;
    };
    const pending = runCpmmPoolObservation(h.options({ clock }));
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(r.firstFailure).toEqual({ stage: "OBSERVATION", code: "CLOCK_THREW" });
    expect(r.observation.started).toBe(true);
    expect(h.instances).toHaveLength(0);
    expect(h.method("getTransaction")).toBe(0);
    expect(h.queue.size).toBe(0);
    expect(r.status).toBe("FAILED");
    expectNoCredential(h.root, r);
  });

  it.each([2, 3, 4])(
    "RN22: cancellation queued %i microtasks after the lifetime clear prevents success",
    async (hops) => {
      const controller = new AbortController();
      const h = harness();
      const { clearTimeout } = h.timers;
      h.timers.clearTimeout = (handle) => {
        clearTimeout(handle);
        if (handle === 1) afterHops(hops, () => controller.abort(new Error(SECRET)));
      };
      const pending = runCpmmPoolObservation(h.options({ signal: controller.signal }));
      await observe(h);
      const r = await pending;
      expect(controller.signal.aborted).toBe(true);
      expect(r).toMatchObject({
        status: "FAILED",
        firstFailure: { stage: "FINALIZATION", code: "CANCELLED" },
        finalizationCancelled: true,
        clockFailure: null,
        cleanupFailures: [],
        observation: {
          report: {
            terminal: { cause: "OBSERVATION_COMPLETED" },
            connectionRunClean: true,
            cancellation: { requestedAtMs: null },
          },
        },
        recording: { finished: true },
        acquisitionEvidence: { verification: { computed: "ACQUIRED_REPRODUCED" } },
        observationEvidence: {
          seal: { ok: true },
          verification: { integrity: { ok: true }, acquisitionBinding: { status: "REPRODUCED" } },
        },
        session: { stopReason: CPMM_RUN_STOP_FINISHED },
        flags: CPMM_EVIDENCE_FALSE_FLAGS,
      });
      expect(h.queue.size).toBe(0);
      expectNoCredential(h.root, r);
    },
  );

  it.each([2, 3, 4])(
    "RN23: a clock fault queued %i microtasks after the lifetime clear prevents success",
    async (hops) => {
      let broken = false;
      const h = harness();
      const { clearTimeout } = h.timers;
      h.timers.clearTimeout = (handle) => {
        clearTimeout(handle);
        if (handle === 1) afterHops(hops, () => (broken = true));
      };
      const clock = () => (broken ? Number.NaN : h.state.now);
      const pending = runCpmmPoolObservation(h.options({ clock }));
      await observe(h);
      const r = await pending;
      expect(broken).toBe(true);
      expect(r).toMatchObject({
        status: "FAILED",
        firstFailure: { stage: "FINALIZATION", code: "CLOCK_INVALID" },
        clockFailure: { stage: "FINALIZATION", code: "CLOCK_INVALID" },
        finalizationCancelled: false,
        cleanupFailures: [],
        observation: { report: { terminal: { cause: "OBSERVATION_COMPLETED" } } },
        observationEvidence: { verification: { integrity: { ok: true } } },
      });
      expect(h.queue.size).toBe(0);
      expectNoCredential(h.root, r);
    },
  );

  it("RN24: queued cancellation after an earlier failure keeps that failure and the evidence", async () => {
    const controller = new AbortController();
    const h = harness();
    const { clearTimeout } = h.timers;
    h.timers.clearTimeout = (handle) => {
      clearTimeout(handle);
      if (handle === 1) afterHops(3, () => controller.abort());
    };
    const pending = runCpmmPoolObservation(h.options({ signal: controller.signal }));
    await h.to(OBS_START + 10);
    h.client.emit("error", new Error("offline test transport failure"));
    await h.to(AFTER_ALL);
    const r = await pending;
    expect(controller.signal.aborted).toBe(true);
    expect(r.firstFailure).toMatchObject({
      stage: "OBSERVATION",
      code: expect.stringMatching(/^TRANSPORT_ERROR/),
    });
    expect(r.status).toBe("FAILED");
    expect(r.finalizationCancelled).toBe(true);
    expect(r.clockFailure).toBeNull();
    expect(r.cleanupFailures).toEqual([]);
    expect(r.observation.report!.terminal.cause).toBe("TRANSPORT_ERROR");
    expect(r.recording.finished).toBe(true);
    expect(r.observationEvidence.verification!.integrity.ok).toBe(true);
    expect(r.acquisitionEvidence.verification).toMatchObject({ computed: "ACQUIRED_REPRODUCED" });
    expect(h.queue.size).toBe(0);
    expectNoCredential(h.root, r);
  });

  it("RN25: cancellation and a clock fault after the result returns never rewrite it", async () => {
    const controller = new AbortController();
    let broken = false;
    const h = harness();
    const pending = runCpmmPoolObservation(
      h.options({
        signal: controller.signal,
        clock: () => (broken ? Number.NaN : h.state.now),
      }),
    );
    await observe(h);
    const r = await pending;
    const before = structuredClone(r);
    expect(r).toMatchObject({ status: "SUCCEEDED", firstFailure: null });
    broken = true;
    controller.abort(new Error(SECRET));
    await h.to(AFTER_ALL + 60_000);
    expect(r).toEqual(before);
    expect(r).toMatchObject({
      status: "SUCCEEDED",
      firstFailure: null,
      clockFailure: null,
      finalizationCancelled: false,
      cleanupFailures: [],
    });
    for (const part of [r, r.observation, r.observationEvidence, r.session, r.cleanupFailures])
      expect(Object.isFrozen(part)).toBe(true);
    expect(() => {
      (r as { status: string }).status = "FAILED";
    }).toThrow(TypeError);
    expect(h.queue.size).toBe(0);
  });
});

describe("CPMM observation run: v1-capable request policy (SIMD-0385)", () => {
  const readSealed = (dir: string, rel: string) =>
    JSON.parse(readFileSync(path.join(dir, ...rel.split("/")), "utf8")) as Record<string, unknown>;

  it("RV1: new runs send the explicit cap-1 request and seal schema 3 with the policy in plan and report", async () => {
    const { h, r } = await shared;
    expect(CPMM_RUN_TRANSACTION_REQUEST).toEqual({ maxSupportedTransactionVersion: 1 });
    expect(CPMM_RUN_EVIDENCE_SCHEMA_VERSION).toBe(3);
    const tx = h.calls.find((c) => c.method === "getTransaction")!;
    expect(tx.params[1]).toEqual({
      encoding: "json",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    expect(r.status).toBe("SUCCEEDED");
    const dir = observationDirOf(h.root);
    expect(readSealed(dir, "cpmm-observation-manifest.json").evidenceSchemaVersion).toBe(3);
    expect(readSealed(dir, "pool-context.json").version).toBe(3);
    expect(readSealed(dir, "report.json")).toMatchObject({
      version: 3,
      transactionRequest: { maxSupportedTransactionVersion: 1 },
    });
    expect(
      (readSealed(dir, "run-plan.json").plan as Record<string, unknown>).transactionRequest,
    ).toEqual({ maxSupportedTransactionVersion: 1 });
  });

  it("RV2: a SYNTHETIC v1 response decodes, ingests and re-derives as a matched swap", async () => {
    // SYNTHETIC SIMD-0385 fixture (Agave 318c00ca JSON shape): never observed mainnet evidence.
    const v1Response = (req: RpcRequest) => {
      const result = txResult(req.params[0] as string) as Record<string, unknown> & {
        transaction: { message: Record<string, unknown> };
      };
      result.version = 1;
      result.transaction.message.transactionConfig = {
        priorityFee: 1_000,
        computeUnitLimit: null,
        loadedAccountsDataSizeLimit: null,
        heapSize: 64 * 1024,
      };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
    };
    const { r } = await cleanRun({ transaction: v1Response });
    expect(r.status).toBe("SUCCEEDED");
    expect(r.firstFailure).toBeNull();
    const v = r.observationEvidence.verification!;
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.acquisitionBinding).toMatchObject({ status: "REPRODUCED" });
    expect(v.rederivation.components!.transactionAnalysis).toMatchObject({
      status: "REPRODUCED",
      analysis: "AVAILABLE",
      comparedExchanges: 1,
      exchanges: [
        {
          decoded: { kind: "RESOLVED_SWAPS" },
          recorded: { factKind: "RESOLVED_SWAPS" },
          comparison: "MATCHED",
        },
      ],
    });
  });
});
