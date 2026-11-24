/**
 * Roadmap step 3: offline tests of the CPMM pool observation entry point
 * (`cpmm-pool-observation.ts`, assessment §8.38.17 item 17 T).
 *
 * Help, dry run, argument and configuration refusals run with dependencies that record any use.
 * Live runs go through the real accepted core with the CLI's proposed profile, over a virtual
 * clock, injected timers, a scripted in-memory fetch, a fake `ws`-like client and a fake signal
 * source. Output goes to fresh temporary directories, removed afterwards. No socket, request or
 * real credential; the child-process checks run only help, a malformed argument and an offline
 * verification of missing directories.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import type {
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
import {
  CPMM_EVIDENCE_FALSE_FLAGS,
  CPMM_EVIDENCE_ROOT_SEGMENTS,
} from "./cpmm-pool-observation-evidence.js";
import {
  CPMM_ACQUISITION_ROOT_SEGMENTS,
  type CpmmObservationRunResult,
} from "./cpmm-pool-observation-run.js";
import {
  CPMM_OBSERVATION_COMPONENT_SOURCES,
  CPMM_OBSERVATION_COMPONENT_VERSIONS,
  CPMM_OBSERVATION_CONFIG_ERRORS,
  CPMM_OBSERVATION_DEPENDENCY_ERRORS,
  CPMM_OBSERVATION_EXIT_CODES,
  CPMM_OBSERVATION_LIVE_FLAG_MEANING,
  CPMM_OBSERVATION_LIVE_STATUS,
  CPMM_OBSERVATION_PROFILE_LABEL,
  CPMM_OBSERVATION_PROFILE_LIMITS,
  CPMM_OBSERVATION_PROFILE_STATUS,
  CPMM_OBSERVATION_RUN_CONSTANTS,
  CPMM_OBSERVATION_SHUTDOWN_FORCED_NOTICE,
  CPMM_OBSERVATION_SHUTDOWN_GRACE_MS,
  CPMM_OBSERVATION_SIGNALS,
  CPMM_OBSERVATION_USAGE,
  buildCpmmObservationPlan,
  cpmmObservationCliExitCode,
  cpmmObservationLiveExitCode,
  cpmmObservationVerifyExitCode,
  isCpmmObservationMainModule,
  isSolanaAddress,
  printableError,
  runCpmmPoolObservationCli,
  type CpmmObservationCliDeps,
  type CpmmObservationCliResult,
  type CpmmObservationEvidenceReport,
  type CpmmObservationSignal,
} from "./cpmm-pool-observation.js";
import { SOLANA_ENDPOINT_ERRORS } from "./paper-single-candidate-diagnostic.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Built at runtime: a synthetic credential value, never a real one. */
const SECRET = ["synthetic", "cli", "credential", "0123456789"].join("-");
const HOST = "rpc.example.test";
const RPC_URL = `https://${HOST}/?api-key=${SECRET}`;
const STREAM_URL = `wss://${HOST}/ws?api-key=${SECRET}`;
const ENV = Object.freeze({ SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: STREAM_URL });
const X = CPMM_OBSERVATION_EXIT_CODES;
const P = CPMM_OBSERVATION_PROFILE_LIMITS;

const CLI_PATH = fileURLToPath(new URL("./cpmm-pool-observation.ts", import.meta.url));
const BACKEND_DIR = path.resolve(path.dirname(CLI_PATH), "..", "..");

/** A child Node process with no configuration-like environment variables. */
function spawnChild(args: string[], cwd = BACKEND_DIR) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/SOLANA|KEY|SECRET|TOKEN|URL/i.test(k)),
    );
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const spawnNode = (args: string[]) => spawnChild(["--import", "tsx", ...args]);

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

const TMP = mkdtempSync(path.join(tmpdir(), "cpmm-cli-test-"));
/** Directory links into the source tree: always unlinked before the recursive removal. */
const links: string[] = [];
afterAll(() => {
  for (const link of links) if (existsSync(link)) unlinkSync(link);
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
class FakeClient implements CpmmWsClientLike {
  public readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  public readonly sent: string[] = [];
  #rs = 0;
  #binaryType = "nodebuffer";
  constructor(
    public readonly address: string,
    public readonly options: CpmmWsClientOptions,
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
  send(data: string, cb: Cb): void {
    this.sent.push(data);
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

/** The CLI's profile timeline: the snapshot one lane pacing after discovery, then observation. */
const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const OBS_START = 1_794_829_400_000;
const T0 = OBS_START - P.session.lanes.SOLANA_RPC.pacingMs;
const RECEIVED_AT = OBS_START + 21_500;
const NOMINAL_END = OBS_START + P.owner.observationMs;
/** Past every owner, drain and cleanup deadline of a run starting at OBS_START. */
const AFTER_ALL = NOMINAL_END + P.owner.unsubscribeAckTimeoutMs + P.owner.drainMs + 10;

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
const SUB_REQ = CPMM_OBSERVATION_RUN_CONSTANTS.subscribeRequestId;
const UNSUB_REQ = CPMM_OBSERVATION_RUN_CONSTANTS.unsubscribeRequestId;
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

function accountsResponse(req: RpcRequest): Response {
  const keys = req.params[0] as string[];
  return Response.json({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      context: { slot: ACCOUNT_SLOT, apiVersion: "2.0.0" },
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
  acquisition?: (n: number, req: RpcRequest, h: Harness) => Response | undefined;
  /** Runs inside the client constructor. */
  onClient?: (h: Harness) => void;
  /** Called for each listener the CLI installs; may throw to refuse it. */
  onInstall?: (event: CpmmObservationSignal) => void;
  /** Called after a listener is attached; may throw (the listener stays attached). */
  onInstalled?: (event: CpmmObservationSignal) => void;
  /** Called before a listener is removed; may throw (the listener stays attached). */
  onBeforeRemove?: (event: CpmmObservationSignal) => void;
  /** Called after a listener is removed; may throw. */
  onRemove?: (event: CpmmObservationSignal) => void;
}

/** Records every use of a dependency that must stay untouched. */
function untouched() {
  const used: string[] = [];
  const env = new Proxy(
    {},
    {
      get: (_t, k) => {
        used.push(`env.get:${String(k)}`);
        return undefined;
      },
      has: (_t, k) => {
        used.push(`env.has:${String(k)}`);
        return false;
      },
      ownKeys: () => {
        used.push("env.ownKeys");
        return [];
      },
    },
  ) as Readonly<Record<string, string | undefined>>;
  const mark = (what: string) => () => {
    used.push(what);
    throw new Error(`${what} ${SECRET}`);
  };
  const deps: CpmmObservationCliDeps = {
    env,
    loadEnvironment: mark("loadEnvironment"),
    fetchFn: mark("fetch") as unknown as typeof fetch,
    loadWebSocketConstructor: mark("loadWebSocketConstructor") as () => never,
    clock: mark("clock"),
    timers: { setTimeout: mark("setTimeout"), clearTimeout: mark("clearTimeout") },
    signals: { on: mark("signals.on"), removeListener: mark("signals.removeListener") },
  };
  return { used, deps };
}

type Harness = ReturnType<typeof harness>;
function harness(o: HarnessOptions = {}) {
  const state = { now: T0 };
  let nextTimer = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const calls: RpcRequest[] = [];
  const urls: string[] = [];
  const instances: FakeClient[] = [];
  const logs: string[] = [];
  const installed = new Map<CpmmObservationSignal, (() => void)[]>();
  const captured: (() => void)[] = [];
  const counters = { loadEnvironment: 0, loadWebSocketConstructor: 0, installs: 0, removals: 0 };
  let acquisitionCalls = 0;
  const root = freshRoot();
  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      queue.set(id, { at: state.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => {
      queue.delete(handle as number);
    },
  };
  const h = {
    state,
    queue,
    calls,
    urls,
    instances,
    logs,
    installed,
    captured,
    counters,
    root,
    get client(): FakeClient {
      return instances[0]!;
    },
    method: (m: string) => calls.filter((c) => c.method === m).length,
    /** Delivers a signal to whatever listeners are installed at that moment. */
    fire: (event: CpmmObservationSignal) => {
      for (const l of [...(installed.get(event) ?? [])]) l();
    },
    to: async (t: number) => {
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
    },
  };
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    const req = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(req);
    if (req.method === "getMultipleAccounts") {
      const n = ++acquisitionCalls;
      return o.acquisition?.(n, req, h as Harness) ?? accountsResponse(req);
    }
    if (req.method === "getTransaction") return txResponse(req);
    throw new Error("UNSCRIPTED_REQUEST");
  }) as unknown as typeof fetch;
  const ctor = class extends FakeClient {
    constructor(address: string, options: CpmmWsClientOptions) {
      super(address, options);
      instances.push(this);
      o.onClient?.(h as Harness);
    }
  } as unknown as CpmmWsClientConstructor;
  const deps = (over: Partial<CpmmObservationCliDeps> = {}): CpmmObservationCliDeps => ({
    env: ENV,
    loadEnvironment: () => {
      counters.loadEnvironment++;
    },
    fetchFn,
    loadWebSocketConstructor: async () => {
      counters.loadWebSocketConstructor++;
      return ctor;
    },
    clock: () => state.now,
    timers,
    signals: {
      on: (event, listener) => {
        o.onInstall?.(event);
        counters.installs++;
        installed.set(event, [...(installed.get(event) ?? []), listener]);
        captured.push(listener);
        o.onInstalled?.(event);
      },
      removeListener: (event, listener) => {
        counters.removals++;
        o.onBeforeRemove?.(event);
        installed.set(
          event,
          (installed.get(event) ?? []).filter((l) => l !== listener),
        );
        o.onRemove?.(event);
      },
    },
    projectRoot: root,
    log: (line) => logs.push(line),
    ...over,
  });
  return Object.assign(h, { deps, fetchFn, ctor });
}

const LIVE_ARGS = (runId = "run-1") => [
  "--pool",
  TARGET.poolAddress,
  "--mint",
  TARGET.candidateMint,
  "--run-id",
  runId,
  "--live",
];

/** Starts the CLI and waits (in real time, bounded) until the core has opened its session. */
async function start(
  h: Harness,
  args: readonly string[],
  over: Partial<CpmmObservationCliDeps> = {},
) {
  let settled = false;
  const pending = runCpmmPoolObservationCli(args, h.deps(over)).finally(() => {
    settled = true;
  });
  pending.catch(() => undefined);
  for (let i = 0; !settled && h.queue.size === 0 && h.calls.length === 0; i++) {
    if (i > 2_000) throw new Error("the core did not start");
    await new Promise((r) => setTimeout(r, 1));
  }
  return pending;
}

/** The client's side of a clean observation: ack, a resolved notification, a duplicate, a ping. */
async function observe(h: Harness, o: { afterAck?: () => void } = {}): Promise<void> {
  await h.to(OBS_START + 10);
  expect(h.instances).toHaveLength(1);
  const c = h.client;
  c.open();
  await h.to(OBS_START + 20);
  c.message(ackFrame());
  await flush();
  o.afterAck?.();
  await h.to(RECEIVED_AT);
  c.message(notif(1));
  await flush();
  await h.to(RECEIVED_AT + 3_000);
  c.message(notif(1));
  c.emit("ping", Buffer.from([9, 9]));
  await flush();
  await h.to(NOMINAL_END);
  c.message(unsubAck());
  await flush();
  await h.to(AFTER_ALL);
}

async function liveRun(o: HarnessOptions = {}, runId = "run-1") {
  const h = harness(o);
  const pending = start(h, LIVE_ARGS(runId));
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
/** Names, sizes and modification times: any write shows up as a difference. */
const snapshot = (dir: string) =>
  listAll(dir).map((f) => {
    const s = statSync(path.join(dir, ...f.split("/")));
    return `${f}:${s.size}:${s.mtimeMs}`;
  });

function expectCredentialFree(h: Harness, r?: CpmmObservationCliResult): void {
  const out = h.logs.join("\n");
  for (const banned of [SECRET, HOST, "https://", "wss://", "api-key"]) {
    expect(out.includes(banned), banned).toBe(false);
    if (r !== undefined) expect(JSON.stringify(r).includes(banned), banned).toBe(false);
  }
  for (const f of listAll(h.root)) {
    const content = readFileSync(path.join(h.root, ...f.split("/")), "utf8");
    expect(content.includes(SECRET), f).toBe(false);
    expect(content.includes("https://"), f).toBe(false);
    expect(content.includes("wss://"), f).toBe(false);
  }
}

const acquisitionRel = (runId = "run-1") => [...CPMM_ACQUISITION_ROOT_SEGMENTS, runId].join("/");
const observationRel = (runId = "run-1") => [...CPMM_EVIDENCE_ROOT_SEGMENTS, runId].join("/");
const acquisitionDirOf = (root: string, runId = "run-1") =>
  path.join(root, ...CPMM_ACQUISITION_ROOT_SEGMENTS, runId);
const observationDirOf = (root: string, runId = "run-1") =>
  path.join(root, ...CPMM_EVIDENCE_ROOT_SEGMENTS, runId);

/** Expects a fixed-text refusal; the message never echoes an argument or configuration value. */
async function expectRefusal(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(printableError(caught)).toBe(message);
  expect(printableError(caught).includes(SECRET)).toBe(false);
}

const shared = liveRun();

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM pool observation CLI (item 17 T, roadmap step 3)", () => {
  it("OC1: --help is inert: nothing loaded, opened, requested or written, and prints the plan", async () => {
    const { used, deps } = untouched();
    const root = freshRoot();
    const logs: string[] = [];
    const globalFetch = vi.spyOn(globalThis, "fetch");
    try {
      const r = await runCpmmPoolObservationCli(["--help"], {
        ...deps,
        projectRoot: root,
        log: (l) => logs.push(l),
      });
      expect(r).toMatchObject({ mode: "HELP", exitCode: X.OK });
      expect(r.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(globalFetch).not.toHaveBeenCalled();
      const again = await runCpmmPoolObservationCli(["--help"], { ...deps, log: () => undefined });
      expect(again.planDigestSha256).toBe(r.planDigestSha256);
    } finally {
      globalFetch.mockRestore();
    }
    expect(used).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    expect(logs[0]).toBe(CPMM_OBSERVATION_USAGE);
    expect(logs[1]).toMatch(/^\[HELP\] No configuration loaded, no transport opened/);
    const plan = JSON.parse(logs[2]!) as ReturnType<typeof buildCpmmObservationPlan>;
    expect(plan.profile).toEqual({
      label: CPMM_OBSERVATION_PROFILE_LABEL,
      status: CPMM_OBSERVATION_PROFILE_STATUS,
      limits: CPMM_OBSERVATION_PROFILE_LIMITS,
      runConstants: CPMM_OBSERVATION_RUN_CONSTANTS,
    });
    expect(plan.liveExecution).toBe(CPMM_OBSERVATION_LIVE_STATUS);
    expect(plan.liveFlag).toBe(CPMM_OBSERVATION_LIVE_FLAG_MEANING);
    expect(CPMM_OBSERVATION_USAGE).toContain("Not operator approval.");
    expect(CPMM_OBSERVATION_LIVE_STATUS).toMatch(/^NOT_APPROVED/);
    expect(logs).toHaveLength(3);
  });

  it("OC2: the dry run is inert and shows the labelled profile with every effective limit", async () => {
    const { used, deps } = untouched();
    const root = freshRoot();
    const logs: string[] = [];
    const args = ["--pool", TARGET.poolAddress, "--mint", TARGET.candidateMint, "--run-id", "r-1"];
    const r = await runCpmmPoolObservationCli(args, {
      ...deps,
      projectRoot: root,
      log: (l) => logs.push(l),
    });
    expect(used).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    expect(r).toMatchObject({ mode: "DRY_RUN", exitCode: X.OK });
    expect(logs.slice(0, 4)).toEqual([
      "[DRY_RUN] No configuration loaded, no transport opened, no request sent, nothing written.",
      `[DRY_RUN] Profile: ${CPMM_OBSERVATION_PROFILE_LABEL} (${CPMM_OBSERVATION_PROFILE_STATUS})`,
      `[DRY_RUN] Live execution: ${CPMM_OBSERVATION_LIVE_STATUS}`,
      `[DRY_RUN] Plan digest (sha256): ${r.planDigestSha256}`,
    ]);
    const plan = JSON.parse(logs[4]!) as ReturnType<typeof buildCpmmObservationPlan>;
    expect(plan).toEqual(
      JSON.parse(
        JSON.stringify(
          buildCpmmObservationPlan({
            mode: "DRY_RUN",
            runId: "r-1",
            target: TARGET,
            acquisitionDir: acquisitionRel("r-1"),
            observationDir: observationRel("r-1"),
          }),
        ),
      ),
    );
    expect(plan.mode).toBe("DRY_RUN");
    expect(plan.target).toEqual(TARGET);
    expect(plan.outputs).toEqual({
      acquisitionDir: acquisitionRel("r-1"),
      observationDir: observationRel("r-1"),
      existingOutput: "REFUSED",
    });
    // The complete effective limits are the ones the core receives; the budget is consistent.
    expect(plan.profile.limits).toEqual(P);
    const b = plan.budget;
    expect(b.lifetimeComposition).toEqual({
      acquisitionDurationMs: 15_000,
      observationMs: 60_000,
      unsubscribeAckTimeoutMs: 5_000,
      drainOrCleanupMs: 20_000,
      requiredMs: 100_000,
      marginMs: 5_000,
      extended: false,
    });
    expect(b.sharedSessionLifetimeMs).toBe(105_000);
    expect(b.http).toMatchObject({
      maxHttpAttempts: 10,
      acquisitionRequests: 2,
      maxTransactionRetrievals: 8,
      sharedBudgetReset: false,
      otherLaneAttempts: 0,
      retries: 0,
    });
    expect(b.connection).toMatchObject({
      connections: 1,
      subscriptions: 1,
      reconnects: 0,
      retries: 0,
      fallback: "NONE",
    });
    for (const lane of ["RUGCHECK", "SOLANA_TRACKER", "DEXSCREENER"] as const) {
      expect(P.session.lanes[lane].maxAttempts).toBe(0);
    }
    // Local sealing and verification: where each happens, and data bounds (not time bounds).
    expect(plan.localOverhead).toMatchObject({ network: "NONE", hardWallClockBound: false });
    expect(Object.values(plan.localOverhead.dataBounds).every((n) => Number.isSafeInteger(n))).toBe(
      true,
    );
    expect(plan.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(Object.values(plan.flags).every((v) => v === false)).toBe(true);
    expect(Object.keys(plan.flags)).toHaveLength(5);
    expect(plan.componentVersions).toEqual(CPMM_OBSERVATION_COMPONENT_VERSIONS);
    // The profile cannot be changed at run time.
    const frozen = (v: unknown): boolean =>
      typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(frozen(P)).toBe(true);
    expect(frozen(CPMM_OBSERVATION_RUN_CONSTANTS)).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/https?:\/\/|wss?:\/\//);
    // Same input, same digest; another target, another digest.
    const again = await runCpmmPoolObservationCli(args, {
      ...deps,
      projectRoot: root,
      log: () => {},
    });
    expect(again.planDigestSha256).toBe(r.planDigestSha256);
    const other = await runCpmmPoolObservationCli(
      ["--pool", TARGET.poolAddress, "--mint", key(42), "--run-id", "r-1"],
      { ...deps, projectRoot: root, log: () => {} },
    );
    expect(other.planDigestSha256).not.toBe(r.planDigestSha256);
    expect(used).toEqual([]);

    // An existing output directory is refused before anything is loaded, in both modes.
    mkdirSync(observationDirOf(root, "r-1"), { recursive: true });
    for (const extra of [[], ["--live"]]) {
      await expectRefusal(
        runCpmmPoolObservationCli([...args, ...extra], { ...deps, projectRoot: root }),
        `[OUTPUT_EXISTS] ${observationRel("r-1")} already exists; refusing to overwrite`,
      );
    }
    mkdirSync(acquisitionDirOf(root, "r-1"), { recursive: true });
    await expectRefusal(
      runCpmmPoolObservationCli([...args, "--live"], { ...deps, projectRoot: root }),
      `[OUTPUT_EXISTS] ${acquisitionRel("r-1")} already exists; refusing to overwrite`,
    );
    expect(used).toEqual([]);
  });

  it("OC2b: inert source: static imports only; configuration, ws and resolver load inside --live", () => {
    const src = readFileSync(CLI_PATH, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
      "node:url",
      "node:util",
      "../candidate-scanner/CpmmPoolWebSocketTransport.js",
      "../candidate-scanner/PaperRequestSession.js",
      "../paper/CanonicalPaths.js",
      "./cpmm-pool-acquisition-evidence.js",
      "./cpmm-pool-observation-evidence.js",
      "./cpmm-pool-observation-run.js",
      "./evidence-credential-sanitizer.js",
    ]);
    // The transport and session imports are types only.
    expect(code).toMatch(/import type \{ CpmmWsClientConstructor \} from/);
    expect(code).toMatch(/import type \{ PaperRequestSessionTimers \} from/);
    expect([...code.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])).toEqual([
      "ws",
      "./paper-trading-daemon.js",
      "./paper-single-candidate-diagnostic.js",
    ]);
    // Configuration, the resolver, fetch, the ws client and signals are reached only after the
    // dry-run return; the two loaders are defined above but called only there.
    const liveStart = code.indexOf('if (parsed.mode === "DRY_RUN")');
    expect(liveStart).toBeGreaterThan(0);
    for (const use of [
      "process.env",
      "resolveSolanaEndpoints(",
      "globalThis.fetch",
      "?? loadInstalledWebSocket",
      "?? loadConfiguredEnvironment",
      "deps.signals",
      "runCpmmPoolObservation(",
    ]) {
      expect(code.indexOf(use), use).toBeGreaterThan(liveStart);
    }
    for (const banned of [
      /\b(writeFileSync|mkdirSync|rmSync|renameSync|appendFileSync|openSync|createWriteStream)\b/,
      /node:(net|http|https|tls|dns|child_process|os|worker_threads)/,
      /\bnew\s+WebSocket\b/,
      /\brequire\(/,
      /\bsecrets:\s*\[[^\]]/,
    ]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
    // The only immediate exit is the shutdown backstop.
    expect([...code.matchAll(/process\.exit\(/g)]).toHaveLength(1);
    expect(code).toMatch(/process\.exitCode = exitCode;/);
    // Every recorded component version names the commit that last changed its source file.
    expect(Object.keys(CPMM_OBSERVATION_COMPONENT_SOURCES).sort()).toEqual(
      Object.keys(CPMM_OBSERVATION_COMPONENT_VERSIONS).sort(),
    );
  });

  it("OC3: malformed arguments are refused with fixed text before anything is loaded", async () => {
    const { used, deps } = untouched();
    const root = freshRoot();
    const pool = TARGET.poolAddress;
    const mint = TARGET.candidateMint;
    const INVALID = "[CLI_INVALID_ARG] unknown, malformed or positional argument";
    const cases: [string[], string][] = [
      [[SECRET], INVALID],
      [[`--${SECRET}`], INVALID],
      [[`--bogus=${SECRET}`], INVALID],
      [["--pool", pool, "--mint", mint, "--run-id", "r", SECRET], INVALID],
      [["--live=yes"], INVALID],
      [["--pool"], INVALID],
      [["--help", "--live"], "[CLI_INVALID_ARG] --help cannot be combined with other options"],
      [["--help", "--help"], "[CLI_INVALID_ARG] --help may be given only once"],
      [
        ["--pool", pool, "--pool", pool, "--mint", mint, "--run-id", "r"],
        "[CLI_INVALID_ARG] --pool may be given only once",
      ],
      [
        ["--pool", pool, "--mint", mint, "--run-id", "r", "--live", "--live"],
        "[CLI_INVALID_ARG] --live may be given only once",
      ],
      [[], "[CLI_INVALID_ARG] --pool, --mint and --run-id are all required"],
      [["--live"], "[CLI_INVALID_ARG] --pool, --mint and --run-id are all required"],
      [
        ["--pool", pool, "--run-id", "r", "--live"],
        "[CLI_INVALID_ARG] --pool, --mint and --run-id are all required",
      ],
      [
        ["--pool", SECRET, "--mint", mint, "--run-id", "r"],
        "[CLI_INVALID_ARG] --pool must be a base58 account address",
      ],
      [
        ["--pool", pool, "--mint", `${mint.slice(0, -1)}0`, "--run-id", "r"],
        "[CLI_INVALID_ARG] --mint must be a base58 account address",
      ],
      [
        ["--pool", pool, "--mint", pool, "--run-id", "r"],
        "[CLI_INVALID_ARG] --pool and --mint must differ",
      ],
      [["--pool", pool, "--mint", mint, "--run-id", "-r"], INVALID],
      ...["../r", "_r", "r/1", "r.1", "", "a".repeat(65)].map((id): [string[], string] => [
        ["--pool", pool, "--mint", mint, "--run-id", id],
        "[CLI_INVALID_ARG] --run-id must be letters, digits, '_' or '-' (up to 64, not starting with '_' or '-')",
      ]),
      [
        [`--pool=${pool}`, `--mint=${mint}`, "--run-id=-r"],
        "[CLI_INVALID_ARG] --run-id must be letters, digits, '_' or '-' (up to 64, not starting with '_' or '-')",
      ],
      [
        ["--verify", "o", "--acquisition-dir", "a", "--live"],
        "[CLI_INVALID_ARG] --verify cannot be combined with --live, --pool, --mint or --run-id",
      ],
      [
        ["--verify", "o", "--acquisition-dir", "a", "--pool", pool],
        "[CLI_INVALID_ARG] --verify cannot be combined with --live, --pool, --mint or --run-id",
      ],
      [
        ["--verify", "o"],
        "[CLI_INVALID_ARG] --verify needs --acquisition-dir with the acquisition directory",
      ],
      [
        ["--acquisition-dir", "a"],
        "[CLI_INVALID_ARG] --verify needs the sealed observation directory",
      ],
      [
        ["--verify", "", "--acquisition-dir", "a"],
        "[CLI_INVALID_ARG] --verify needs the sealed observation directory",
      ],
    ];
    for (const [args, message] of cases) {
      await expectRefusal(runCpmmPoolObservationCli(args, { ...deps, projectRoot: root }), message);
    }
    expect(used).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    // Addresses are canonical base58 encodings of exactly 32 bytes.
    for (const ok of [pool, mint, key(1), "11111111111111111111111111111111"]) {
      expect(isSolanaAddress(ok), ok).toBe(true);
    }
    for (const bad of [
      "1111111111111111111111111111111",
      new PublicKey(new Uint8Array(32).fill(255)).toBase58() + "1",
      encodeBase58(new Uint8Array(31).fill(9)),
      encodeBase58(new Uint8Array(33).fill(9)),
      `${pool.slice(0, -1)}0`,
      `${pool.slice(0, -1)}l`,
      ` ${pool}`,
    ]) {
      expect(isSolanaAddress(bad), bad).toBe(false);
    }
    // Text shaped like a refusal but not created by the entry point is never printed.
    expect(printableError(new Error(`[CLI_INVALID_ARG] x`))).toBe("[UNEXPECTED_ERROR]");
  });

  it("OC4: missing or invalid configuration refuses --live before any transport or write", async () => {
    const env = (rpc?: string, ws?: string) => ({ SOLANA_RPC_URL: rpc, SOLANA_WS_URL: ws });
    const cases: [Record<string, string | undefined>, string][] = [
      [{}, SOLANA_ENDPOINT_ERRORS.rpc],
      [env(""), SOLANA_ENDPOINT_ERRORS.rpc],
      [env(`ftp://${HOST}/?k=${SECRET}`), SOLANA_ENDPOINT_ERRORS.rpc],
      [env(RPC_URL), CPMM_OBSERVATION_CONFIG_ERRORS.wsExplicit],
      [env(RPC_URL, ""), CPMM_OBSERVATION_CONFIG_ERRORS.wsExplicit],
      [env(`https://x.alchemy.com/v2/${SECRET}`), SOLANA_ENDPOINT_ERRORS.wsRequired],
      [env(RPC_URL, `ws://${HOST}/?k=${SECRET}`), SOLANA_ENDPOINT_ERRORS.wsDowngrade],
      [env(RPC_URL, `https://${HOST}/?k=${SECRET}`), SOLANA_ENDPOINT_ERRORS.wsInvalid],
      [env(`http://${HOST}/?k=${SECRET}`, STREAM_URL), CPMM_OBSERVATION_CONFIG_ERRORS.rpcHttps],
      [
        env(`http://${HOST}/?k=${SECRET}`, `ws://${HOST}/`),
        CPMM_OBSERVATION_CONFIG_ERRORS.rpcHttps,
      ],
      [env(`${RPC_URL}#${SECRET}`, STREAM_URL), CPMM_OBSERVATION_CONFIG_ERRORS.fragment],
      [env(RPC_URL, `${STREAM_URL}#f`), CPMM_OBSERVATION_CONFIG_ERRORS.fragment],
    ];
    for (const [e, message] of cases) {
      const h = harness();
      await expectRefusal(runCpmmPoolObservationCli(LIVE_ARGS(), h.deps({ env: e })), message);
      expect(h.counters.loadEnvironment, message).toBe(1);
      expect(h.counters.loadWebSocketConstructor).toBe(0);
      expect(h.counters.installs).toBe(0);
      expect(h.calls).toHaveLength(0);
      expect(h.queue.size).toBe(0);
      expect(readdirSync(h.root)).toEqual([]);
      expect(h.logs).toEqual([]);
    }
    // A loader or ws-client failure prints a fixed refusal, never its text or its code.
    const loader = harness();
    await expectRefusal(
      runCpmmPoolObservationCli(
        LIVE_ARGS(),
        loader.deps({
          loadEnvironment: () => {
            throw new Error(`could not parse ${RPC_URL}`);
          },
        }),
      ),
      CPMM_OBSERVATION_DEPENDENCY_ERRORS.configurationLoad,
    );
    const ws = harness();
    await expectRefusal(
      runCpmmPoolObservationCli(
        LIVE_ARGS(),
        ws.deps({
          loadWebSocketConstructor: () => Promise.reject(new Error(`[WS_MISSING] ${SECRET}`)),
        }),
      ),
      CPMM_OBSERVATION_DEPENDENCY_ERRORS.webSocketClientLoad,
    );
    for (const h of [loader, ws]) {
      expect(h.calls).toHaveLength(0);
      expect(h.counters.installs).toBe(0);
      expect(readdirSync(h.root)).toEqual([]);
    }
  });

  it("OC5: a fake-provider live run reports its outcome, requests, evidence and flags, exit 0", async () => {
    const { h, r } = await shared;
    expect(r.mode).toBe("LIVE");
    expect(r.exitCode).toBe(X.OK);
    expect(h.counters).toEqual({
      loadEnvironment: 1,
      loadWebSocketConstructor: 1,
      installs: CPMM_OBSERVATION_SIGNALS.length,
      removals: CPMM_OBSERVATION_SIGNALS.length,
    });
    // Both listeners are detached once the run ends.
    expect([...h.installed.values()].flat()).toEqual([]);
    // The configured endpoints reached the core unchanged; nothing else was contacted.
    expect(new Set(h.urls)).toEqual(new Set([RPC_URL]));
    expect(h.calls.map((c) => c.method)).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getTransaction",
    ]);
    expect(h.instances).toHaveLength(1);
    expect(h.client.address).toBe(STREAM_URL);
    const sentIds = h.client.sent.map((s) => (JSON.parse(s) as { id: number }).id);
    expect(sentIds).toEqual([SUB_REQ, UNSUB_REQ]);
    const report = r.report!;
    expect(report.execution).toEqual({
      status: "SUCCEEDED",
      firstFailure: null,
      clockFailure: null,
      finalizationCancelled: false,
      cancelled: false,
      cleanupFailures: [],
      sessionStopReason: report.execution.sessionStopReason,
      ownerTerminalCause: "OBSERVATION_COMPLETED",
      connectionRunClean: true,
    });
    expect(report.requests).toEqual({
      httpAttempts: 3,
      acquisitionRequests: 2,
      observationRequests: 1,
      webSocketConnections: 1,
    });
    expect(report.evidence.acquisition).toMatchObject({
      path: acquisitionRel(),
      seal: "SEALED",
      integrity: "VERIFIED",
      integrityCode: null,
      computed: "ACQUIRED_REPRODUCED",
    });
    expect(report.evidence.acquisition.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.evidence.observation).toMatchObject({
      path: observationRel(),
      seal: "SEALED",
      integrity: { ok: true, problems: [] },
      retention: { status: "COMPLETE", reasons: [] },
      rederivation: { implementedComponents: "REPRODUCED", transactionAnalysis: "AVAILABLE" },
      acquisitionBinding: "REPRODUCED",
      poolContextProvenance: "ACQUIRED_BOUND",
    });
    expect(report.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(report.entryPoint).toEqual({ signalCleanupFailures: [] });
    expect(r.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    // Distinct lines for each part of the outcome, then the machine-readable report.
    const at = (prefix: string) => h.logs.filter((l) => l.startsWith(prefix));
    expect(at("[LIVE] Profile:")).toEqual([
      `[LIVE] Profile: ${CPMM_OBSERVATION_PROFILE_LABEL} (${CPMM_OBSERVATION_PROFILE_STATUS})`,
    ]);
    expect(h.logs).toContain(`[LIVE] ${CPMM_OBSERVATION_LIVE_FLAG_MEANING}`);
    expect(at("[LIVE] Execution:")).toEqual(["[LIVE] Execution: SUCCEEDED; first failure: none"]);
    expect(at("[LIVE] Cleanup failures:")).toEqual(["[LIVE] Cleanup failures: none"]);
    expect(at("[LIVE] Entry-point cleanup failures:")).toEqual([
      "[LIVE] Entry-point cleanup failures: none",
    ]);
    expect(at("[LIVE] SIGINT received").concat(at("[LIVE] SIGTERM received"))).toEqual([]);
    expect(at("[LIVE] Requests:")).toEqual([
      "[LIVE] Requests: 3 HTTP (2 acquisition, 1 transaction retrieval); WebSocket connections: 1",
    ]);
    expect(at("[LIVE] Acquisition bundle:")).toEqual([
      `[LIVE] Acquisition bundle: ${acquisitionRel()} (SEALED)`,
    ]);
    expect(at("[LIVE] Observation bundle:")).toEqual([
      `[LIVE] Observation bundle: ${observationRel()} (SEALED)`,
    ]);
    expect(at("[LIVE] Retention:")).toEqual(["[LIVE] Retention: COMPLETE"]);
    expect(at("[LIVE] Acquisition binding:")).toEqual(["[LIVE] Acquisition binding: REPRODUCED"]);
    expect(at("[LIVE] Re-derivation:")[0]).toMatch(/implemented components REPRODUCED/);
    expect(at("[LIVE] Qualification flags (all false):")).toHaveLength(1);
    expect(at("[LIVE] Exit code 0.")).toHaveLength(1);
    expect(JSON.parse(h.logs.at(-1)!)).toEqual(JSON.parse(JSON.stringify(report)));
    expectCredentialFree(h, r);
    expect(h.queue.size).toBe(0);
  });

  it("OC6: cancellation reaches the core, keeps sealed evidence, detaches handlers, exit 6", async () => {
    // During observation, through SIGINT.
    const h = harness();
    const pending = start(h, LIVE_ARGS());
    await observe(h, { afterAck: () => h.fire("SIGINT") });
    const r = await pending;
    expect(r.exitCode).toBe(X.CANCELLED);
    const e = r.report!.execution;
    expect(e.cancelled).toBe(true);
    expect(e.status).toBe("FAILED");
    expect(e.firstFailure).toMatch(/^OBSERVATION:CANCELLED/);
    expect(e.ownerTerminalCause).toBe("CANCELLED");
    expect(r.report!.evidence.observation).toMatchObject({
      seal: "SEALED",
      integrity: { ok: true },
      acquisitionBinding: "REPRODUCED",
    });
    expect(h.instances).toHaveLength(1);
    expect([...h.installed.values()].flat()).toEqual([]);
    expect(h.counters.removals).toBe(CPMM_OBSERVATION_SIGNALS.length);
    expect(h.logs.filter((l) => l.includes(" received: cancelling"))).toEqual([
      "[LIVE] SIGINT received: cancelling the run; the core still seals what it has",
    ]);
    // A signal after the result (even through a retained listener) changes nothing.
    const before = JSON.stringify(r);
    const logsBefore = [...h.logs];
    for (const l of h.captured) l();
    h.fire("SIGINT");
    h.fire("SIGTERM");
    await h.to(AFTER_ALL + 60_000);
    expect(JSON.stringify(r)).toBe(before);
    expect(h.logs).toEqual(logsBefore);
    expect(h.calls).toHaveLength(2);
    expect(r.report!.requests).toMatchObject({ httpAttempts: 2, webSocketConnections: 1 });
    expectCredentialFree(h, r);

    // During acquisition, through SIGTERM: no client is ever constructed.
    const a = harness({
      acquisition: (n, _req, x) => {
        if (n === 1) x.fire("SIGTERM");
        return undefined;
      },
    });
    const p2 = start(a, LIVE_ARGS());
    await a.to(OBS_START + 10_000);
    const r2 = await p2;
    expect(r2.exitCode).toBe(X.CANCELLED);
    expect(r2.report!.execution.firstFailure).toMatch(/^ACQUISITION:CALLER_CANCELLED/);
    expect(r2.report!.evidence.acquisition).toMatchObject({
      seal: "SEALED",
      integrity: "VERIFIED",
      computed: "ACQUISITION_FAILED",
    });
    expect(r2.report!.evidence.observation.seal).toBe("NOT_SEALED");
    expect(r2.report!.requests.webSocketConnections).toBe(0);
    expect(a.instances).toHaveLength(0);
    expect(a.calls).toHaveLength(1);
    expect([...a.installed.values()].flat()).toEqual([]);
    expect(a.logs.filter((l) => l.includes(" received: cancelling"))).toEqual([
      "[LIVE] SIGTERM received: cancelling the run; the core still seals what it has",
    ]);
    expectCredentialFree(a, r2);
  });

  it("OC7: a failed run reports its first failure with intact evidence, exit 3", async () => {
    const h = harness({
      acquisition: (_n, req) =>
        Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: SECRET } }),
    });
    const pending = start(h, LIVE_ARGS());
    await h.to(OBS_START + 10_000);
    const r = await pending;
    expect(r.exitCode).toBe(X.RUN_FAILED);
    expect(r.report!.execution).toMatchObject({
      status: "FAILED",
      firstFailure: "ACQUISITION:RPC_ERROR",
      cancelled: false,
      ownerTerminalCause: null,
    });
    expect(r.report!.requests).toEqual({
      httpAttempts: 1,
      acquisitionRequests: 1,
      observationRequests: 0,
      webSocketConnections: 0,
    });
    expect(r.report!.evidence.acquisition).toMatchObject({
      seal: "SEALED",
      integrity: "VERIFIED",
      computed: "ACQUISITION_FAILED",
    });
    expect(r.report!.evidence.observation).toEqual({
      path: null,
      seal: "NOT_SEALED",
      manifestSha256: null,
      integrity: null,
      retention: null,
      rederivation: null,
      acquisitionBinding: null,
      poolContextProvenance: null,
    });
    expect(h.logs).toContain("[LIVE] Execution: FAILED; first failure: ACQUISITION:RPC_ERROR");
    expect(h.logs).toContain("[LIVE] Observation bundle: none (NOT_SEALED)");
    expect(h.logs).toContain(
      "[LIVE] Exit code 3. Ends here: no follow-up, retry or reacquisition.",
    );
    expect(h.instances).toHaveLength(0);
    expect([...h.installed.values()].flat()).toEqual([]);
    expectCredentialFree(h, r);
  });

  it("OC8: a sealing failure is reported and never triggers reacquisition, exit 5", async () => {
    // The observation directory appears during the run: the acquisition bundle stays verified.
    const { h, r } = await liveRun({
      onClient: (x) => mkdirSync(observationDirOf(x.root), { recursive: true }),
    });
    expect(r.exitCode).toBe(X.SEAL_FAILED);
    expect(r.report!.execution.firstFailure).toBe(
      "OBSERVATION_EVIDENCE:SEAL_FAILED:OUTPUT_DIRECTORY_EXISTS",
    );
    expect(r.report!.evidence.observation).toMatchObject({
      path: null,
      seal: "FAILED:OUTPUT_DIRECTORY_EXISTS",
      integrity: null,
    });
    expect(r.report!.evidence.acquisition).toMatchObject({
      seal: "SEALED",
      computed: "ACQUIRED_REPRODUCED",
    });
    expect(readdirSync(observationDirOf(h.root))).toEqual([]);
    expect(h.calls).toHaveLength(3);
    expect(h.instances).toHaveLength(1);
    expect(h.logs).toContain(`[LIVE] Observation bundle: none (FAILED:OUTPUT_DIRECTORY_EXISTS)`);
    expectCredentialFree(h, r);

    // The acquisition directory appears while the snapshot is in flight: nothing is observed.
    const a = harness({
      acquisition: (n, _req, x) => {
        if (n === 2) mkdirSync(acquisitionDirOf(x.root), { recursive: true });
        return undefined;
      },
    });
    const p2 = start(a, LIVE_ARGS());
    await a.to(OBS_START + 10_000);
    const r2 = await p2;
    expect(r2.exitCode).toBe(X.SEAL_FAILED);
    expect(r2.report!.execution.firstFailure).toBe(
      "ACQUISITION_EVIDENCE:SEAL_FAILED:OUTPUT_EXISTS",
    );
    expect(r2.report!.evidence.acquisition).toMatchObject({
      path: null,
      seal: "FAILED:OUTPUT_EXISTS",
      integrity: "NOT_VERIFIED",
    });
    expect(a.calls).toHaveLength(2);
    expect(a.instances).toHaveLength(0);
    expect([...a.installed.values()].flat()).toEqual([]);
  });

  it("OC9: --verify is read-only, loads no configuration, and reports the analysis limitation", async () => {
    const { h } = await shared;
    const { used, deps } = untouched();
    const logs: string[] = [];
    const before = snapshot(h.root);
    const verify = (obs: string, acq: string) => {
      logs.length = 0;
      return runCpmmPoolObservationCli(["--verify", obs, "--acquisition-dir", acq], {
        ...deps,
        projectRoot: h.root,
        log: (l) => logs.push(l),
      });
    };
    // Relative paths resolve against the project root.
    const r = await verify(observationRel(), acquisitionRel());
    expect(used).toEqual([]);
    expect(snapshot(h.root)).toEqual(before);
    expect(r.mode).toBe("VERIFY");
    const v = r.verification!;
    expect(v.acquisition).toMatchObject({
      path: acquisitionRel(),
      integrity: "VERIFIED",
      computed: "ACQUIRED_REPRODUCED",
    });
    expect(v.observation).toMatchObject({
      path: observationRel(),
      integrity: { ok: true, problems: [] },
      retention: { status: "COMPLETE" },
      acquisitionBinding: "REPRODUCED",
    });
    // Without the run's credentials the transaction responses are not re-analysed: limited.
    expect(v.observation.rederivation!.transactionAnalysis).not.toBe("AVAILABLE");
    expect(v.observation.rederivation!.implementedComponents).not.toBe("REPRODUCED");
    expect(r.exitCode).toBe(X.EVIDENCE_LIMITED);
    expect(logs[0]).toBe(
      "[VERIFY] Offline and read-only: no configuration or credential loaded, nothing written.",
    );
    expect(logs.some((l) => l.startsWith("[VERIFY] Limitation:"))).toBe(true);
    expect(logs.at(-1)).toMatch(/^\[VERIFY\] Qualification flags \(all false\):/);
    expect(logs.join("\n")).not.toMatch(/https?:\/\/|wss?:\/\/|api-key/);

    const acqDir = acquisitionDirOf(h.root);
    const obsDir = observationDirOf(h.root);
    const copy = (dir: string) => {
      const parent = path.join(TMP, `copy-${++dirCounter}`);
      mkdirSync(parent);
      const to = path.join(parent, path.basename(dir));
      cpSync(dir, to, { recursive: true });
      return to;
    };
    const flip = (file: string) => {
      const bytes = readFileSync(file);
      const i = bytes.length - 2;
      bytes[i] = bytes[i]! ^ 1;
      writeFileSync(file, bytes);
    };
    // Missing acquisition dependency.
    const missing = await verify(obsDir, path.join(TMP, "no-such-acquisition"));
    expect(missing.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(missing.verification!.observation.acquisitionBinding).not.toBe("REPRODUCED");
    // Altered acquisition dependency.
    const alteredAcq = copy(acqDir);
    flip(path.join(alteredAcq, "accounts.json"));
    const altered = await verify(obsDir, alteredAcq);
    expect(altered.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(altered.verification!.acquisition.integrity).not.toBe("VERIFIED");
    expect(altered.verification!.observation.acquisitionBinding).toBe("MISMATCH");
    // A different, genuine acquisition (another run id) never binds.
    const other = await liveRun({}, "run-2");
    expect(other.r.exitCode).toBe(X.OK);
    const different = await verify(obsDir, acquisitionDirOf(other.h.root, "run-2"));
    expect(different.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(different.verification!.acquisition.integrity).toBe("VERIFIED");
    expect(different.verification!.observation.acquisitionBinding).toBe("MISMATCH");
    // A relocated exact copy still binds.
    const moved = await verify(copy(obsDir), copy(acqDir));
    expect(moved.exitCode).toBe(X.EVIDENCE_LIMITED);
    expect(moved.verification!.observation.acquisitionBinding).toBe("REPRODUCED");
    // Altered and incomplete observation bundles.
    const alteredObs = copy(obsDir);
    flip(path.join(alteredObs, "ledger.json"));
    const changed = await verify(alteredObs, acqDir);
    expect(changed.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(changed.verification!.observation.integrity!.ok).toBe(false);
    const incomplete = copy(obsDir);
    rmSync(path.join(incomplete, "ledger.json"));
    const partial = await verify(incomplete, acqDir);
    expect(partial.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(partial.verification!.observation.integrity!.ok).toBe(false);
    const absent = await verify(path.join(TMP, "no-such-observation"), acqDir);
    expect(absent.exitCode).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(used).toEqual([]);
    expect(snapshot(h.root)).toEqual(before);
  });

  it("OC10: exit codes are read from the frozen result in a fixed order", () => {
    type Acq = CpmmObservationEvidenceReport["acquisition"];
    type Obs = CpmmObservationEvidenceReport["observation"];
    const ev = (acq: Partial<Acq> = {}, obs: Partial<Obs> = {}): CpmmObservationEvidenceReport => ({
      acquisition: {
        path: "a",
        seal: "SEALED",
        manifestSha256: "0".repeat(64),
        integrity: "VERIFIED",
        integrityCode: null,
        computed: "ACQUIRED_REPRODUCED",
        ...acq,
      },
      observation: {
        path: "o",
        seal: "SEALED",
        manifestSha256: "1".repeat(64),
        integrity: { ok: true, problems: [] },
        retention: { status: "COMPLETE", reasons: [] },
        rederivation: {
          status: "REPRODUCED",
          implementedComponents: "REPRODUCED",
          transactionAnalysis: "AVAILABLE",
          transactionAnalysisUnavailableReason: null,
        },
        acquisitionBinding: "REPRODUCED",
        poolContextProvenance: "ACQUIRED_BOUND",
        ...obs,
      },
    });
    const run = (over: {
      status?: "SUCCEEDED" | "FAILED";
      firstFailure?: { stage: string; code: string } | null;
      finalizationCancelled?: boolean;
      started?: boolean;
    }) =>
      ({
        status: over.status ?? (over.firstFailure ? "FAILED" : "SUCCEEDED"),
        firstFailure: over.firstFailure ?? null,
        finalizationCancelled: over.finalizationCancelled ?? false,
        observation: { started: over.started ?? true },
      }) as unknown as CpmmObservationRunResult;
    const fail = (stage: string, code: string) => ({ firstFailure: { stage, code } });
    const limitedRederivation = {
      rederivation: {
        ...ev().observation.rederivation!,
        implementedComponents: "MISSING_EVIDENCE",
      },
    };
    const notSealed: Partial<Obs> = { seal: "NOT_SEALED", integrity: null, retention: null };
    const cases: [string, CpmmObservationRunResult, CpmmObservationEvidenceReport, number][] = [
      ["clean", run({}), ev(), X.OK],
      [
        "retention incomplete",
        run({}),
        ev({}, { retention: { status: "INCOMPLETE", reasons: ["r"] } }),
        X.EVIDENCE_LIMITED,
      ],
      ["re-derivation limited", run({}), ev({}, limitedRederivation), X.EVIDENCE_LIMITED],
      [
        "setup refusal",
        run(fail("SETUP", "OPTIONS_INVALID")),
        ev({ seal: "NOT_SEALED" }, notSealed),
        X.INVALID,
      ],
      [
        "setup cancelled",
        run(fail("SETUP", "CANCELLED")),
        ev({ seal: "NOT_SEALED" }, notSealed),
        X.CANCELLED,
      ],
      [
        "acquisition failed",
        run({ ...fail("ACQUISITION", "RPC_ERROR"), started: false }),
        ev({ computed: "ACQUISITION_FAILED" }, notSealed),
        X.RUN_FAILED,
      ],
      [
        "acquisition not sealed",
        run({ ...fail("ACQUISITION_EVIDENCE", "SEAL_FAILED:X"), started: false }),
        ev({ seal: "FAILED:X", integrity: "NOT_VERIFIED" }, notSealed),
        X.SEAL_FAILED,
      ],
      [
        "acquisition not sealed, cancelled",
        run({
          ...fail("ACQUISITION_EVIDENCE", "SEAL_FAILED:X"),
          started: false,
          finalizationCancelled: true,
        }),
        ev({ seal: "NOT_SEALED" }, notSealed),
        X.SEAL_FAILED,
      ],
      [
        "observation not sealed",
        run(fail("OBSERVATION_EVIDENCE", "SEAL_FAILED:X")),
        ev({}, { ...notSealed, seal: "FAILED:X" }),
        X.SEAL_FAILED,
      ],
      [
        "observation not sealed, cancelled",
        run(fail("OBSERVATION", "CANCELLED")),
        ev({}, notSealed),
        X.SEAL_FAILED,
      ],
      [
        "acquisition integrity failed",
        run({}),
        ev({ integrity: "FAILED" }),
        X.EVIDENCE_NOT_VERIFIED,
      ],
      ["acquisition mismatch", run({}), ev({ computed: "MISMATCH" }), X.EVIDENCE_NOT_VERIFIED],
      [
        "observation integrity failed",
        run({}),
        ev({}, { integrity: { ok: false, problems: ["p"] } }),
        X.EVIDENCE_NOT_VERIFIED,
      ],
      ["observation not verified", run({}), ev({}, { integrity: null }), X.EVIDENCE_NOT_VERIFIED],
      [
        "binding mismatch",
        run({}),
        ev({}, { acquisitionBinding: "MISMATCH" }),
        X.EVIDENCE_NOT_VERIFIED,
      ],
      ["binding missing", run({}), ev({}, { acquisitionBinding: null }), X.EVIDENCE_NOT_VERIFIED],
      [
        "re-derivation mismatch",
        run({}),
        ev(
          {},
          {
            rederivation: { ...ev().observation.rederivation!, implementedComponents: "MISMATCH" },
          },
        ),
        X.EVIDENCE_NOT_VERIFIED,
      ],
      [
        "cancelled, not verified",
        run(fail("OBSERVATION", "CANCELLED")),
        ev({}, { integrity: { ok: false, problems: ["p"] } }),
        X.EVIDENCE_NOT_VERIFIED,
      ],
      [
        "cancelled, limited",
        run(fail("OBSERVATION", "CANCELLED")),
        ev({}, limitedRederivation),
        X.CANCELLED,
      ],
      [
        "caller cancelled",
        run({ ...fail("ACQUISITION", "CALLER_CANCELLED:x"), started: false }),
        ev({ computed: "ACQUISITION_FAILED" }, notSealed),
        X.CANCELLED,
      ],
      [
        "finalization cancelled",
        run({
          status: "FAILED",
          finalizationCancelled: true,
          firstFailure: { stage: "FINALIZATION", code: "CANCELLED" },
        }),
        ev(),
        X.CANCELLED,
      ],
      [
        "failed, limited",
        run(fail("OBSERVATION", "SESSION_STOPPED")),
        ev({}, limitedRederivation),
        X.RUN_FAILED,
      ],
      ["failed, verified", run(fail("RECORDING", "X")), ev(), X.RUN_FAILED],
    ];
    for (const [label, result, evidence, code] of cases) {
      expect(cpmmObservationLiveExitCode(result, evidence), label).toBe(code);
    }
    // --verify judges the evidence only.
    expect(cpmmObservationVerifyExitCode(ev())).toBe(X.OK);
    expect(cpmmObservationVerifyExitCode(ev({}, limitedRederivation))).toBe(X.EVIDENCE_LIMITED);
    expect(cpmmObservationVerifyExitCode(ev({ integrity: "FAILED" }))).toBe(
      X.EVIDENCE_NOT_VERIFIED,
    );
    expect(cpmmObservationVerifyExitCode(ev({}, { acquisitionBinding: "MISSING_EVIDENCE" }))).toBe(
      X.EVIDENCE_NOT_VERIFIED,
    );
    expect(new Set(Object.values(X)).size).toBe(Object.keys(X).length);
    // A listener the entry point could not remove turns only success or limited evidence into 7.
    const failures = ["SIGNAL_REMOVE_FAILED:SIGINT"];
    for (const code of Object.values(X)) {
      expect(cpmmObservationCliExitCode(code, [])).toBe(code);
      const expected = code === X.OK || code === X.EVIDENCE_LIMITED ? X.CLEANUP_FAILED : code;
      expect(cpmmObservationCliExitCode(code, failures), String(code)).toBe(expected);
    }
  });

  it("OC11: signal handlers are detached on every exit, including install and removal failures", async () => {
    // The second install fails: the first is removed, and the core never runs.
    const h = harness({
      onInstall: (event) => {
        if (event === "SIGTERM") throw new Error(`[SIGNAL] ${SECRET}`);
      },
    });
    await expectRefusal(
      runCpmmPoolObservationCli(LIVE_ARGS(), h.deps()),
      CPMM_OBSERVATION_DEPENDENCY_ERRORS.signalInstall,
    );
    expect([...h.installed.values()].flat()).toEqual([]);
    // Removal is attempted for every registration attempted, including the refused one.
    expect(h.counters).toMatchObject({ installs: 1, removals: 2 });
    expect(h.calls).toHaveLength(0);
    expect(h.queue.size).toBe(0);
    expect(readdirSync(h.root)).toEqual([]);

    // A removal failure is reported without changing the core's result; the other is removed.
    const f = harness({
      acquisition: (_n, req) =>
        Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "x" } }),
      onRemove: (event) => {
        if (event === "SIGINT") throw new Error(SECRET);
      },
    });
    const pending = start(f, LIVE_ARGS());
    await f.to(OBS_START + 10_000);
    const r = await pending;
    expect(r.exitCode).toBe(X.RUN_FAILED);
    expect(r.report!.execution.firstFailure).toBe("ACQUISITION:RPC_ERROR");
    expect(r.report!.entryPoint.signalCleanupFailures).toEqual(["SIGNAL_REMOVE_FAILED:SIGINT"]);
    expect(f.counters.removals).toBe(2);
    expect(f.installed.get("SIGTERM")).toEqual([]);
    expectCredentialFree(f, r);
  });

  it("OC12: printable errors carry the entry point's fixed text or a fixed code, never free text", () => {
    expect(printableError(new Error(`[OUTPUT_EXISTS] x`))).toBe("[UNEXPECTED_ERROR]");
    expect(printableError(new Error(CPMM_OBSERVATION_CONFIG_ERRORS.rpcHttps))).toBe(
      "[UNEXPECTED_ERROR]",
    );
    expect(printableError(new Error(`[SOME_CODE] ${SECRET}`))).toBe("[UNEXPECTED_ERROR]");
    expect(printableError(new Error(`${RPC_URL} failed`))).toBe("[UNEXPECTED_ERROR]");
    expect(printableError(`[CLI_INVALID_ARG] ${SECRET}`)).toBe("[UNEXPECTED_ERROR]");
    expect(printableError(undefined)).toBe("[UNEXPECTED_ERROR]");
    expect(printableError({ message: `[CLI_INVALID_ARG] ${SECRET}` })).toBe("[UNEXPECTED_ERROR]");
  });

  it("OC13: the entry point exits with the documented codes and prints no argument value", async () => {
    const run = (args: string[]) => spawnNode([CLI_PATH, ...args]);
    const missing = path.join(TMP, `absent-${++dirCounter}`);
    const [help, bad, verify] = await Promise.all([
      run(["--help"]),
      run(["--pool", SECRET, "--bogus"]),
      run(["--verify", path.join(missing, "o"), "--acquisition-dir", path.join(missing, "a")]),
    ]);
    expect(help.code).toBe(X.OK);
    expect(help.stdout.startsWith(CPMM_OBSERVATION_USAGE)).toBe(true);
    expect(help.stderr).toBe("");
    expect(bad.code).toBe(X.INVALID);
    expect(bad.stdout).toBe("");
    expect(bad.stderr.trim()).toBe(
      "[CPMM_POOL_OBSERVATION_ERROR] [CLI_INVALID_ARG] unknown, malformed or positional argument",
    );
    expect(verify.code).toBe(X.EVIDENCE_NOT_VERIFIED);
    expect(verify.stdout).toContain("[VERIFY] Limitation:");
    expect(verify.stderr).toBe("");
    expect(existsSync(missing)).toBe(false);
    for (const out of [help, bad, verify]) {
      expect(out.stdout + out.stderr).not.toContain(SECRET);
    }
  }, 45_000);

  it("OC14: the exit code is set and the loop drains; only a lingering handle is forced out", async () => {
    const drive = (body: string) =>
      spawnNode([
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)}); ${body}`,
      ]);
    const started = Date.now();
    const [drained, lingering] = await Promise.all([
      drive("m.settleCpmmObservationProcess(3, 30_000);"),
      drive("m.settleCpmmObservationProcess(5, 200); setInterval(() => {}, 1_000);"),
    ]);
    // Drained on its own: the unref'd backstop neither fired nor held the process for its bound.
    expect(drained.code).toBe(3);
    expect(drained.stderr).toBe("");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(lingering.code).toBe(5);
    expect(lingering.stderr.trim()).toBe(`${CPMM_OBSERVATION_SHUTDOWN_FORCED_NOTICE} after 200 ms`);
    expect(CPMM_OBSERVATION_SHUTDOWN_GRACE_MS).toBe(5_000);
  }, 45_000);

  it("OC15: a dependency's error is never printed as trusted text, whatever its prefix", async () => {
    const D = CPMM_OBSERVATION_DEPENDENCY_ERRORS;
    const codes = [
      "CLI_INVALID_ARG",
      "OUTPUT_EXISTS",
      "MISSING_CONFIGURATION",
      "INVALID_CONFIGURATION",
    ];
    for (const code of codes) {
      const message = `[${code}] ${RPC_URL}`;
      const cases: [string, Partial<CpmmObservationCliDeps>, HarnessOptions, keyof typeof D][] = [
        [
          "loader throws",
          {
            loadEnvironment: () => {
              throw new Error(message);
            },
          },
          {},
          "configurationLoad",
        ],
        [
          "loader rejects",
          { loadEnvironment: () => Promise.reject(new Error(message)) },
          {},
          "configurationLoad",
        ],
        [
          "ws loader rejects",
          { loadWebSocketConstructor: () => Promise.reject(new Error(message)) },
          {},
          "webSocketClientLoad",
        ],
        [
          "signal registration throws",
          {},
          {
            onInstall: () => {
              throw new Error(message);
            },
          },
          "signalInstall",
        ],
      ];
      for (const [label, over, options, expected] of cases) {
        const h = harness(options);
        let caught: unknown = null;
        try {
          await runCpmmPoolObservationCli(LIVE_ARGS(), h.deps(over));
        } catch (err) {
          caught = err;
        }
        const printed = printableError(caught);
        for (const banned of [SECRET, HOST, "https://", "api-key"]) {
          expect(printed.includes(banned), `${code} ${label}: ${banned}`).toBe(false);
        }
        expect(printed, `${code} ${label}`).toBe(D[expected]);
        expect(h.calls).toHaveLength(0);
        expect(h.queue.size).toBe(0);
        expect([...h.installed.values()].flat()).toEqual([]);
        expect(readdirSync(h.root)).toEqual([]);
      }
    }
    // Text that merely looks like a refusal is not trusted, nor is anything derived from one.
    expect(printableError(new Error(CPMM_OBSERVATION_CONFIG_ERRORS.rpcHttps))).toBe(
      "[UNEXPECTED_ERROR]",
    );
    expect(printableError(new Error(`[OUTPUT_EXISTS] ${SECRET}`))).toBe("[UNEXPECTED_ERROR]");
    const h = harness();
    let refusal: unknown = null;
    try {
      await runCpmmPoolObservationCli(LIVE_ARGS(), h.deps({ env: {} }));
    } catch (err) {
      refusal = err;
    }
    expect(printableError(refusal)).toBe(SOLANA_ENDPOINT_ERRORS.rpc);
    expect(printableError(Object.create(refusal as object))).toBe("[UNEXPECTED_ERROR]");
    expect(() => {
      (refusal as { message: string }).message = SECRET;
    }).toThrow(TypeError);
    expect(printableError(refusal)).toBe(SOLANA_ENDPOINT_ERRORS.rpc);
  });

  it("OC16: only executing the entry file runs it; importing it from a same-named file does not", async () => {
    const href = pathToFileURL(CLI_PATH).href;
    const wrappers = ["cpmm-pool-observation.js", "cpmm-pool-observation.ts"].map((name) => {
      const dir = path.join(TMP, `wrapper-${++dirCounter}`);
      mkdirSync(dir);
      const file = path.join(dir, name);
      writeFileSync(
        file,
        `import(${JSON.stringify(href)}).then(() => console.log("WRAPPER_IMPORTED"), () => { console.log("WRAPPER_IMPORT_FAILED"); process.exitCode = 9; });\n`,
      );
      return file;
    });
    // A directory link to the scripts directory: the entry argument differs from the real path.
    const link = path.join(TMP, `link-${++dirCounter}`);
    links.push(link);
    symlinkSync(path.dirname(CLI_PATH), link, "junction");
    const direct = [
      path.relative(BACKEND_DIR, CLI_PATH),
      CLI_PATH.replace(/\\/g, "/"),
      path.join(link, path.basename(CLI_PATH)),
    ];
    if (process.platform === "win32") {
      direct.push(path.join(path.dirname(CLI_PATH).toUpperCase(), path.basename(CLI_PATH)));
    }
    const repoRoot = path.dirname(BACKEND_DIR);
    const tsxCli = path.join(BACKEND_DIR, "node_modules", "tsx", "dist", "cli.mjs");
    const [imported, runbook, ...directs] = await Promise.all([
      Promise.all(wrappers.map((w) => spawnNode([w, "--help"]))),
      // The runbook's own command form, from the repository root.
      spawnChild([tsxCli, "backend/src/scripts/cpmm-pool-observation.ts", "--help"], repoRoot),
      ...direct.map((p) => spawnNode([p, "--help"])),
    ]);
    for (const out of imported) {
      expect(out.stdout.trim()).toBe("WRAPPER_IMPORTED");
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
    }
    for (const out of [runbook, ...directs]) {
      expect(out.code).toBe(X.OK);
      expect(out.stdout.startsWith(CPMM_OBSERVATION_USAGE)).toBe(true);
      expect(out.stderr).toBe("");
    }
    expect(isCpmmObservationMainModule(CLI_PATH, href)).toBe(true);
    for (const w of wrappers) expect(isCpmmObservationMainModule(w, href)).toBe(false);
    expect(isCpmmObservationMainModule(undefined, href)).toBe(false);
    expect(isCpmmObservationMainModule("", href)).toBe(false);
    expect(
      isCpmmObservationMainModule(path.join(TMP, "absent", "cpmm-pool-observation.ts"), href),
    ).toBe(false);
    expect(isCpmmObservationMainModule(path.join(link, path.basename(CLI_PATH)), href)).toBe(true);
    unlinkSync(link);
    expect(existsSync(CLI_PATH)).toBe(true);
  }, 45_000);

  it("OC17: a failed listener removal is reported, later removals still run, and the exit is not success", async () => {
    const h = harness({
      onBeforeRemove: (event) => {
        if (event === "SIGINT") throw new Error(`[OUTPUT_EXISTS] ${SECRET}`);
      },
    });
    const pending = start(h, LIVE_ARGS());
    await observe(h);
    const r = await pending;
    await h.to(AFTER_ALL + 60_000);
    expect(r.exitCode).not.toBe(X.OK);
    expect(r.exitCode).toBe(X.CLEANUP_FAILED);
    const report = r.report!;
    expect(report.entryPoint).toEqual({ signalCleanupFailures: ["SIGNAL_REMOVE_FAILED:SIGINT"] });
    // The core's frozen result and evidence are reported unchanged.
    const clean = (await shared).r.report!;
    expect(report.execution).toEqual(clean.execution);
    expect(report.requests).toEqual(clean.requests);
    expect(report.flags).toEqual(CPMM_EVIDENCE_FALSE_FLAGS);
    expect(report.evidence.acquisition).toMatchObject({
      seal: "SEALED",
      integrity: "VERIFIED",
      computed: "ACQUIRED_REPRODUCED",
    });
    expect(report.evidence.observation).toMatchObject({
      seal: "SEALED",
      integrity: { ok: true, problems: [] },
      retention: { status: "COMPLETE", reasons: [] },
      acquisitionBinding: "REPRODUCED",
    });
    // The SIGTERM removal still ran; the SIGINT listener the source kept is reported.
    expect(h.counters.removals).toBe(CPMM_OBSERVATION_SIGNALS.length);
    expect(h.installed.get("SIGTERM")).toEqual([]);
    expect(h.installed.get("SIGINT")).toHaveLength(1);
    expect(h.logs).toContain("[LIVE] Entry-point cleanup failures: SIGNAL_REMOVE_FAILED:SIGINT");
    expect(h.logs).toContain(
      `[LIVE] Exit code ${X.CLEANUP_FAILED}. Ends here: no follow-up, retry or reacquisition.`,
    );
    expect(JSON.parse(h.logs.at(-1)!)).toEqual(JSON.parse(JSON.stringify(report)));
    // The listener left attached, and every other retained one, is inert after the run.
    const logs = [...h.logs];
    const before = JSON.stringify(r);
    h.fire("SIGINT");
    for (const l of h.captured) l();
    await h.to(AFTER_ALL + 120_000);
    expect(h.logs).toEqual(logs);
    expect(JSON.stringify(r)).toBe(before);
    expect(h.calls).toHaveLength(3);
    expect(h.queue.size).toBe(0);
    expectCredentialFree(h, r);

    // Both removals fail: both are reported in order; a failed run keeps its own exit code.
    const f = harness({
      acquisition: (_n, req) =>
        Response.json({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "x" } }),
      onBeforeRemove: () => {
        throw new Error(SECRET);
      },
    });
    const p2 = start(f, LIVE_ARGS());
    await f.to(OBS_START + 10_000);
    const r2 = await p2;
    expect(r2.exitCode).toBe(X.RUN_FAILED);
    expect(r2.report!.entryPoint.signalCleanupFailures).toEqual([
      "SIGNAL_REMOVE_FAILED:SIGINT",
      "SIGNAL_REMOVE_FAILED:SIGTERM",
    ]);
    expect(f.counters.removals).toBe(2);
    expectCredentialFree(f, r2);
  });

  it("OC18: a listener attached by a registration that then throws is removed as well", async () => {
    const D = CPMM_OBSERVATION_DEPENDENCY_ERRORS;
    const attachThenThrow = (event: CpmmObservationSignal) => {
      if (event === "SIGTERM") throw new Error(`[INVALID_CONFIGURATION] ${SECRET}`);
    };
    const h = harness({ onInstalled: attachThenThrow });
    let caught: unknown = null;
    try {
      await runCpmmPoolObservationCli(LIVE_ARGS(), h.deps());
    } catch (err) {
      caught = err;
    }
    expect([...h.installed.values()].flat()).toEqual([]);
    expect(printableError(caught).includes(SECRET)).toBe(false);
    expect(printableError(caught)).toBe(D.signalInstall);
    expect(h.counters).toMatchObject({ installs: 2, removals: 2 });
    expect(h.calls).toHaveLength(0);
    expect(h.queue.size).toBe(0);
    expect(readdirSync(h.root)).toEqual([]);

    // A removal failing as well is named in the (fixed) refusal; what stays attached is inert.
    const g = harness({
      onInstalled: attachThenThrow,
      onBeforeRemove: (event) => {
        if (event === "SIGINT") throw new Error(SECRET);
      },
    });
    let caught2: unknown = null;
    try {
      await runCpmmPoolObservationCli(LIVE_ARGS(), g.deps());
    } catch (err) {
      caught2 = err;
    }
    expect(printableError(caught2)).toBe(
      `${D.signalInstall}; listener cleanup failed: SIGNAL_REMOVE_FAILED:SIGINT`,
    );
    expect(g.installed.get("SIGINT")).toHaveLength(1);
    expect(g.installed.get("SIGTERM")).toEqual([]);
    const logs = [...g.logs];
    g.fire("SIGINT");
    for (const l of g.captured) l();
    await flush();
    expect(g.logs).toEqual(logs);
    expect(g.calls).toHaveLength(0);
    expect(g.queue.size).toBe(0);
  });

  it("OC19: the plan places each bundle's sealing correctly and claims no hard wall-clock bound", async () => {
    const plan = buildCpmmObservationPlan({
      mode: "DRY_RUN",
      runId: "r-1",
      target: TARGET,
      acquisitionDir: acquisitionRel("r-1"),
      observationDir: observationRel("r-1"),
    });
    expect(plan.localOverhead).toMatchObject({
      network: "NONE",
      acquisitionEvidence: "SEALED_AND_VERIFIED_BEFORE_OBSERVATION_WITHIN_SESSION_LIFETIME",
      observationEvidence: "SEALED_AND_VERIFIED_AFTER_SESSION_SHUTDOWN",
      hardWallClockBound: false,
      shutdownFallback: { graceMs: CPMM_OBSERVATION_SHUTDOWN_GRACE_MS },
    });
    expect(plan.localOverhead).not.toHaveProperty("timedBySessionLifetime");
    expect(plan.localOverhead.description).not.toMatch(/bounded by the evidence size limits/);
    // The real run agrees: the acquisition is sealed and verified before the connection exists,
    // and the observation bundle appears only after it.
    const seen: { acquisition: string[]; observation: boolean }[] = [];
    const { h, r } = await liveRun(
      {
        onClient: (x) =>
          seen.push({
            acquisition: readdirSync(acquisitionDirOf(x.root, "run-t")),
            observation: existsSync(observationDirOf(x.root, "run-t")),
          }),
      },
      "run-t",
    );
    expect(r.exitCode).toBe(X.OK);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.acquisition).toContain("evidence-manifest.json");
    expect(seen[0]!.observation).toBe(false);
    expect(existsSync(observationDirOf(h.root, "run-t"))).toBe(true);
    expect(r.report!.execution.sessionStopReason).not.toBeNull();
  });
});
