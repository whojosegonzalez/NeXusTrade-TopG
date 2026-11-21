/**
 * Raydium CPMM transaction source adapter: synthetic offline tests (assessment §8.38.17 item 12).
 *
 * Harness: a real PaperRequestSession with a virtual clock and timers, a scripted in-memory fetch
 * (no network), a real evidence recorder bound to that session, and pool contexts from the real
 * Stage 1 adapter on its fixtures. Transactions are local literal `getTransaction` results.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
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
  decodeRaydiumCpmmTransactionSwaps,
} from "./RaydiumCpmmSwapDecoder.js";
import {
  CPMM_MAX_ANALYSIS_RESPONSE_BYTES,
  CPMM_RESPONSE_ANALYSIS_NOT_PROVEN,
  CPMM_TX_PURPOSE,
  RaydiumCpmmTransactionSourceAdapter,
  analyzeCpmmTransactionResponse,
  createCpmmExchangeEvidenceRecorder,
  type CpmmLifecycleGate,
  type CpmmResolutionFact,
  type CpmmTransactionSourceOptions,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";

type Loose = ReturnType<typeof JSON.parse>;

// ---------------------------------------------------------------------------------------------
// Literal fixtures
// ---------------------------------------------------------------------------------------------

const SECRET_KEY = "k3yS3cr3tAbCdEfGh1234";
const QUOTED_SECRET = 'pa"ss_word99';
const RPC_URL = `https://rpc.example.test/?api-key=${SECRET_KEY}`;
const SECRETS = [RPC_URL, SECRET_KEY, QUOTED_SECRET];

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
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
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

/** A base-input target swap with its two literal TransferChecked children and SwapEvent log. */
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
const memoIx = (): Ix => ({ program: MEMO, accounts: [], data: Uint8Array.from([1]) });

const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const RECEIVED_AT = 1_794_829_421_500;

/** A legacy `encoding: "json"` getTransaction result. */
function txResult(sig: string, top: Ix[], extraLogs: string[] = []): Loose {
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
  logs.push(...extraLogs);
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
      innerInstructions: inner,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: logs,
    },
  };
}

const notice = (n: number, extra: Record<string, unknown> = {}) => ({
  signature: signatureOf(n),
  slot: SLOT,
  receivedAtMs: RECEIVED_AT,
  blockTime: BLOCK_TIME,
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// Harness: real session, virtual clock and timers, scripted fetch
// ---------------------------------------------------------------------------------------------

type Responder = (req: { id: number; body: string; signal: AbortSignal }) => Promise<Response>;

const reply =
  (make: (id: number) => string | Uint8Array, status = 200, headers: Record<string, string> = {}) =>
  (): Responder =>
  async ({ id }) =>
    new Response(make(id) as BodyInit, { status, headers });
const rpcResult = (result: unknown) =>
  reply((id) => JSON.stringify({ jsonrpc: "2.0", id, result }));
const okSwap = (n: number, top: Ix[] = [swapIx("BUY")]) => rpcResult(txResult(signatureOf(n), top));
const networkError = (): Responder => async () => {
  throw new TypeError("fetch failed");
};
const hang =
  (): Responder =>
  ({ signal }) =>
    new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

interface HarnessOptions {
  lifetimeMs?: number;
  maxHttpAttempts?: number;
  maxPending?: number;
  maxTracked?: number;
  maxResponseBytes?: number;
  laneMaxResponseBytes?: number;
  open?: boolean;
}

function harness(o: HarnessOptions = {}) {
  const state = { now: 1_000_000 };
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const T: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { at: state.now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const fireDue = () => {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= state.now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  const calls: { url: string; method: string; body: string; headers: unknown }[] = [];
  const script: Responder[] = [];
  const fetchFn = (async (url: unknown, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      body: String(init.body),
      headers: init.headers,
    });
    const r = script.shift();
    if (!r) throw new Error("UNSCRIPTED_REQUEST");
    return r({
      id: JSON.parse(String(init.body)).id,
      body: String(init.body),
      signal: init.signal as AbortSignal,
    });
  }) as unknown as typeof fetch;
  const recorder = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: o.maxPending ?? 8 });
  const tap = { fn: (e: PaperRequestExchangeEvidence) => recorder.observe(e) };
  const lane = (maxAttempts: number, pacingMs: number, maxResponseBytes: number) => ({
    maxAttempts,
    pacingMs,
    maxResponseBytes,
  });
  const max = o.maxHttpAttempts ?? 20;
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    limits: {
      lifetimeMs: o.lifetimeMs ?? 600_000,
      maxHttpAttempts: max,
      requestTimeoutMs: 10_000,
      lanes: {
        SOLANA_RPC: lane(max, 2_500, o.laneMaxResponseBytes ?? 200_000),
        RUGCHECK: lane(0, 1, 1),
        SOLANA_TRACKER: lane(0, 1, 1),
        DEXSCREENER: lane(0, 1, 1),
      },
    },
    clock: () => state.now,
    timers: T,
    onExchangeComplete: (e) => tap.fn(e),
  });
  recorder.bind(session);
  if (o.open !== false) session.open();
  const options: CpmmTransactionSourceOptions = {
    pool: POOL,
    session,
    evidence: recorder,
    rpcUrl: RPC_URL,
    secrets: SECRETS,
    maxTrackedSignatures: o.maxTracked ?? 32,
    maxResponseBytes: o.maxResponseBytes ?? 100_000,
  };
  const adapter = new RaydiumCpmmTransactionSourceAdapter(options);
  return {
    state,
    session,
    recorder,
    adapter,
    options,
    calls,
    script,
    tap,
    timers,
    fireDue,
    /** Advances the virtual clock and fires due timers. */
    advance(ms: number) {
      state.now += ms;
      fireDue();
    },
    ledger: () => session.getStatus().ledger,
    deadline: () => session.getDeadlineMs() as number,
    /** One resolve, after spacing past the previous dispatch. */
    async resolve(n: unknown, responder?: Responder, gate?: CpmmLifecycleGate) {
      state.now += 2_500;
      if (responder) script.push(responder);
      return this.adapter.resolve(n, gate);
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** Facts are deep-frozen and hold only strings, numbers, booleans, bigint and null. */
function expectPlainFrozen(v: unknown, path = "fact"): void {
  if (v === null || ["string", "number", "boolean", "bigint"].includes(typeof v)) return;
  expect(typeof v, path).toBe("object");
  expect(Buffer.isBuffer(v) || v instanceof Uint8Array, path).toBe(false);
  expect(Object.isFrozen(v), path).toBe(true);
  for (const [k, x] of Object.entries(v as object)) expectPlainFrozen(x, `${path}.${k}`);
}
function expectSecretFree(fact: unknown): void {
  const s = json(fact).toLowerCase();
  for (const forbidden of ["k3ys3cr3", "api-key", "rpc.example.test", 'pa\\"ss', "https:"]) {
    expect(s, forbidden).not.toContain(forbidden);
  }
}
const kindOf = (f: CpmmResolutionFact) => [f.kind, f.code, f.detail];

const tracker = (poolId = POOL.poolAddress, tokenMint = POOL.candidateMint) =>
  new RollingTradeFlowTracker({
    poolId,
    tokenMint,
    trackingStartedMs: 1_794_829_400_000,
    clock: () => 1_794_829_422_000,
  });

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("Raydium CPMM transaction source adapter (synthetic, offline)", () => {
  it("T-00: construction requires a bound recorder, a verified pool and safe options", () => {
    const h = harness();
    const ctor = (over: Record<string, unknown>) => () =>
      new RaydiumCpmmTransactionSourceAdapter({
        ...h.options,
        ...over,
      } as unknown as CpmmTransactionSourceOptions);
    expect(ctor({})).not.toThrow();
    // Unbound recorder, and a recorder bound to another session.
    const unbound = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 1 });
    expect(ctor({ evidence: unbound })).toThrow(/not bound to this session/);
    const other = harness();
    expect(ctor({ evidence: other.recorder })).toThrow(/not bound to this session/);
    expect(() => h.recorder.bind(h.session)).toThrow(/already bound/);
    expect(() => createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 0 })).toThrow();
    expect(() =>
      createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 1, extra: 1 } as never),
    ).toThrow();
    // Options.
    expect(ctor({ clock: () => 1 })).toThrow(/unsupported option clock/);
    expect(ctor({ maxResponseBytes: 200_001 })).toThrow(/maxResponseBytes/);
    expect(ctor({ maxResponseBytes: 0 })).toThrow(/maxResponseBytes/);
    expect(ctor({ maxTrackedSignatures: 0 })).toThrow(/maxTrackedSignatures/);
    expect(ctor({ secrets: [SECRET_KEY] })).toThrow(/rpcUrl must be a string listed in secrets/);
    expect(ctor({ secrets: [...SECRETS, "short"] })).toThrow(/printable ASCII/);
    expect(ctor({ secrets: [...SECRETS, "has space"] })).toThrow(/printable ASCII/);
    expect(ctor({ secrets: [] })).toThrow(/secrets/);
    expect(ctor({ rpcUrl: "ftp://x.example.test/", secrets: ["ftp://x.example.test/"] })).toThrow(
      /http/,
    );
    expect(ctor({ pool: { ...POOL, baseDecimals: 19 } })).toThrow(/verified CPMM pool/);
    expect(ctor({ pool: { ...POOL, verification: {} } })).toThrow(/verified CPMM pool/);
    expect(ctor({ session: {} })).toThrow(/PaperRequestSession/);
    expect(h.ledger()).toHaveLength(0);
  });

  it("T-01 (A1): one exact POST through the session; signature identity; session-unique ID; replayable", async () => {
    const h = harness();
    // Other owners have taken IDs 1 and 2 from the same session.
    expect(h.session.nextJsonRpcId()).toBe(1);
    expect(h.session.nextJsonRpcId()).toBe(2);
    const f = await h.resolve(notice(1), okSwap(1)());
    expect(kindOf(f)).toEqual(["RESOLVED_SWAPS", null, null]);
    expect(f.ingestible).toBe(true);
    expect(f.replay).toBe("DECODER_REPLAYABLE");
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      signature: signatureOf(1),
      poolId: POOL.poolAddress,
      tokenMint: POOL.candidateMint,
      side: "BUY",
      slot: SLOT,
      receiptTimestampMs: RECEIVED_AT,
      eventTimestampMs: BLOCK_TIME * 1000,
      timestampProvenance: "ON_CHAIN_BLOCK_TIME",
    });
    const expectedBody =
      `{"jsonrpc":"2.0","id":3,"method":"getTransaction","params":["${signatureOf(1)}",` +
      `{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}]}`;
    expect(h.calls).toEqual([
      {
        url: RPC_URL,
        method: "POST",
        body: expectedBody,
        headers: { "content-type": "application/json" },
      },
    ]);
    expect(h.ledger()).toHaveLength(1);
    expect(h.ledger()[0]).toMatchObject({
      lane: "SOLANA_RPC",
      owner: "FLOW",
      purpose: CPMM_TX_PURPOSE,
      requestedIdentity: signatureOf(1),
      jsonRpcId: 3,
      httpStatus: 200,
      bodyComplete: true,
      error: null,
    });
    const ex = f.exchange!;
    expect(ex).toMatchObject({
      seq: 1,
      jsonRpcId: 3,
      requestBody: expectedBody,
      evidence: "VERIFIED",
      evidenceDetail: null,
      bodyState: "COMPLETE",
      sessionError: null,
      httpStatus: 200,
    });
    expect(ex.body.state).toBe("STORED");
    expect(ex.body.sha256).toBe(sha256(ex.body.payload!));
    expect(ex.body.retainedBytes).toBe(Buffer.byteLength(ex.body.payload!));
    expect(f.postAwaitCheck).toMatchObject({ passed: true, sessionState: "OPEN", cause: null });
    // Decoder replay: re-decoding the stored bytes reproduces the result exactly.
    const replayed = decodeRaydiumCpmmTransactionSwaps(JSON.parse(ex.body.payload!).result, POOL, {
      receiptTimestampMs: RECEIVED_AT,
    });
    expect(json(replayed.events)).toBe(json(f.events));
    expectPlainFrozen(f);
    expectSecretFree(f);
    // No retry: a network failure is one dispatch, and the signature is never requested again.
    const g = await h.resolve(notice(2), networkError());
    expect(kindOf(g)).toEqual(["TRANSPORT_FAILED", "NETWORK_ERROR", null]);
    expect(h.calls).toHaveLength(2);
    expect(kindOf(await h.resolve(notice(2)))).toEqual([
      "DUPLICATE_NOTIFICATION",
      "DUPLICATE_SIGNATURE",
      null,
    ]);
    expect(h.calls).toHaveLength(2);
    expect(h.ledger()).toHaveLength(2);
  });

  it("T-02 (A2): the envelope is strict (ID echo, version, keys, result/error exclusivity)", async () => {
    const h = harness();
    const tx = (n: number) => txResult(signatureOf(n), [swapIx("BUY")]);
    const cases: [string, (id: number, n: number) => unknown][] = [
      ["ID_MISMATCH", (id, n) => ({ jsonrpc: "2.0", id: id + 1, result: tx(n) })],
      ["ID_MISMATCH", (id, n) => ({ jsonrpc: "2.0", id: String(id), result: tx(n) })],
      ["ID_MISSING", (_, n) => ({ jsonrpc: "2.0", result: tx(n) })],
      ["JSONRPC_VERSION", (id, n) => ({ jsonrpc: "1.0", id, result: tx(n) })],
      ["JSONRPC_VERSION", (id, n) => ({ id, result: tx(n) })],
      ["ENVELOPE_EXTRA_KEY", (id, n) => ({ jsonrpc: "2.0", id, result: tx(n), context: {} })],
      [
        "RESULT_AND_ERROR",
        (id, n) => ({ jsonrpc: "2.0", id, result: tx(n), error: { code: 1, message: "x" } }),
      ],
      ["NO_RESULT_OR_ERROR", (id) => ({ jsonrpc: "2.0", id })],
      ["ENVELOPE_NOT_OBJECT", () => [1]],
      ["ENVELOPE_NOT_OBJECT", () => "string"],
      ["ENVELOPE_NOT_OBJECT", () => null],
      [
        "ERROR_OBJECT_INVALID",
        (id) => ({ jsonrpc: "2.0", id, error: { code: "x", message: "m" } }),
      ],
      ["ERROR_OBJECT_INVALID", (id) => ({ jsonrpc: "2.0", id, error: { code: 1 } })],
      ["RESULT_NOT_OBJECT", (id) => ({ jsonrpc: "2.0", id, result: [] })],
    ];
    let n = 10;
    for (const [code, make] of cases) {
      n++;
      const sig = n;
      const f = await h.resolve(notice(sig), reply((id) => JSON.stringify(make(id, sig)))());
      expect(kindOf(f), code).toEqual(["MALFORMED_RESPONSE", code, null]);
      expect(f.ingestible).toBe(false);
      expect(f.decoder).toBeNull();
      expect(f.exchange!.body.state).toBe("STORED");
    }
    expect(h.ledger()).toHaveLength(cases.length);
  });

  it("T-03 (A3): signature, slot and notified blockTime must match before decoding", async () => {
    const h = harness();
    const variant = (n: number, edit: (r: Loose) => void) => {
      const r = txResult(signatureOf(n), [swapIx("BUY")]);
      edit(r);
      return rpcResult(r)();
    };
    const cases: [string, string, (r: Loose) => void, Record<string, unknown>?][] = [
      [
        "SIGNATURE_MISMATCH",
        "SIGNATURE_DIFFERENT",
        (r) => (r.transaction.signatures = [signatureOf(200)]),
      ],
      ["SIGNATURE_MISMATCH", "SIGNATURE_DIFFERENT", (r) => (r.transaction.signatures[0] += " ")],
      [
        "SIGNATURE_MISMATCH",
        "SIGNATURE_DIFFERENT",
        (r) => (r.transaction.signatures[0] = ` ${r.transaction.signatures[0]}`),
      ],
      ["SIGNATURE_MISMATCH", "SIGNATURE_MISSING", (r) => (r.transaction.signatures = [])],
      ["SIGNATURE_MISMATCH", "SIGNATURE_MISSING", (r) => delete r.transaction],
      ["METADATA_CONTRADICTION", "SLOT_MISMATCH", (r) => (r.slot = SLOT + 1)],
      ["METADATA_CONTRADICTION", "SLOT_INVALID", (r) => delete r.slot],
      ["METADATA_CONTRADICTION", "SLOT_INVALID", (r) => (r.slot = String(SLOT))],
      ["METADATA_CONTRADICTION", "BLOCK_TIME_MISMATCH", (r) => (r.blockTime = BLOCK_TIME + 1)],
      ["METADATA_CONTRADICTION", "BLOCK_TIME_UNAVAILABLE", (r) => (r.blockTime = null)],
      ["METADATA_CONTRADICTION", "BLOCK_TIME_UNAVAILABLE", (r) => delete r.blockTime],
    ];
    let n = 30;
    for (const [kind, code, edit] of cases) {
      n++;
      const f = await h.resolve(notice(n), variant(n, edit));
      expect(kindOf(f), code).toEqual([kind, code, null]);
      expect(f.decoder).toBeNull();
      expect(f.events).toEqual([]);
    }
    // Without a notified blockTime (absent or null), the decoder's own blockTime rule applies.
    const absent = { ...notice(60) } as Record<string, unknown>;
    delete absent.blockTime;
    expect((await h.resolve(absent, okSwap(60)())).kind).toBe("RESOLVED_SWAPS");
    expect((await h.resolve(notice(61, { blockTime: null }), okSwap(61)())).kind).toBe(
      "RESOLVED_SWAPS",
    );
  });

  it("T-04 (A4): not found, RPC error (code only), HTTP error, network error and oversize", async () => {
    const h = harness({ maxResponseBytes: 2_000 });
    const nf = await h.resolve(notice(1), rpcResult(null)());
    expect(kindOf(nf)).toEqual(["TRANSACTION_NOT_FOUND", "RESULT_NULL", null]);
    const rpcErr = await h.resolve(
      notice(2),
      reply((id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32009, message: "slot skipped: private detail" },
        }),
      )(),
    );
    expect(kindOf(rpcErr)).toEqual(["RPC_ERROR", "JSON_RPC_ERROR", null]);
    expect(rpcErr.rpcErrorCode).toBe(-32009);
    // The message survives only inside the stored body; the fact fields never copy it.
    expect(json({ ...rpcErr, exchange: null })).not.toContain("private detail");
    const http = await h.resolve(notice(3), reply(() => "Service Unavailable", 503)());
    expect(kindOf(http)).toEqual(["HTTP_ERROR", "HTTP_STATUS_503", null]);
    expect(http.exchange).toMatchObject({
      httpStatus: 503,
      evidence: "VERIFIED",
      bodyState: "COMPLETE",
    });
    expect(http.exchange!.body).toMatchObject({
      state: "WITHHELD",
      withheldReason: "UNPARSABLE_JSON",
    });
    const net = await h.resolve(notice(4), networkError());
    expect(kindOf(net)).toEqual(["TRANSPORT_FAILED", "NETWORK_ERROR", null]);
    expect(net.exchange).toMatchObject({
      evidence: "VERIFIED",
      bodyState: "NOT_READ",
      httpStatus: null,
      sessionError: "NETWORK_ERROR",
    });
    expect(net.exchange!.body.state).toBe("NONE");
    const big = "x".repeat(3_000);
    const partial = await h.resolve(notice(5), reply(() => big)());
    expect(kindOf(partial)).toEqual(["TRANSPORT_FAILED", "RESPONSE_TOO_LARGE", null]);
    expect(partial.exchange!.bodyState).toBe("PARTIAL_OVERFLOW");
    expect(partial.exchange!.body).toMatchObject({
      state: "WITHHELD",
      withheldReason: "PARTIAL_BODY",
      payload: null,
      retainedBytes: 2_000,
      observedBytes: 3_000,
      sha256: sha256(big.slice(0, 2_000)),
    });
    const declared = await h.resolve(
      notice(6),
      reply(() => "{}", 200, { "content-length": "5000" })(),
    );
    expect(kindOf(declared)).toEqual(["TRANSPORT_FAILED", "RESPONSE_TOO_LARGE", null]);
    expect(declared.exchange!.bodyState).toBe("NOT_READ");
    expect(declared.exchange!.body.state).toBe("NONE");
    for (const f of [nf, rpcErr, http, net, partial, declared]) {
      expect(f.ingestible).toBe(false);
      expectPlainFrozen(f);
      expectSecretFree(f);
    }
    expect(h.ledger()).toHaveLength(6);
  });

  it("T-05 (A5): the session refuses, counts, paces and stops; fixed codes only", async () => {
    // Not open.
    const closed = harness({ open: false });
    expect(kindOf(await closed.resolve(notice(1)))).toEqual([
      "REQUEST_REFUSED",
      "REQUEST_SESSION_NOT_OPEN",
      null,
    ]);
    // Stopped with arbitrary owner text: the refusal is the session's fixed code.
    const stopped = harness();
    stopped.session.stop(`operator note ${SECRET_KEY}`);
    const s = await stopped.resolve(notice(1));
    expect(kindOf(s)).toEqual(["REQUEST_REFUSED", "REQUEST_SESSION_STOPPED", null]);
    expectSecretFree(s);
    // Lifetime expired by the clock, before the lifetime timer fired.
    const expired = harness();
    expired.state.now = expired.deadline() - 2_500;
    expect(expired.session.isOpen()).toBe(true);
    expect(kindOf(await expired.resolve(notice(1)))).toEqual([
      "REQUEST_REFUSED",
      "LIFETIME_EXPIRED",
      null,
    ]);
    // Ceiling.
    const ceiling = harness({ maxHttpAttempts: 1 });
    expect((await ceiling.resolve(notice(1), okSwap(1)())).kind).toBe("RESOLVED_SWAPS");
    expect(kindOf(await ceiling.resolve(notice(2)))).toEqual([
      "REQUEST_REFUSED",
      "HTTP_ATTEMPT_CEILING_REACHED",
      null,
    ]);
    expect(ceiling.ledger()).toHaveLength(1);
    // Caller refusal: arbitrary text is recorded as the fixed CALLER_REFUSAL and is not counted.
    const refused = harness();
    const r = await refused.resolve(notice(1), undefined, {
      refusal: () => `EPOCH_ENDED ${SECRET_KEY}`,
    });
    expect(kindOf(r)).toEqual(["REQUEST_REFUSED", "CALLER_REFUSAL", null]);
    expect(refused.ledger()).toHaveLength(0);
    expect(refused.calls).toHaveLength(0);
    expect(refused.session.getStatus().refusalsByReason).toEqual({ CALLER_REFUSAL: 1 });
    expectSecretFree(r);
    const throwing = await refused.resolve(notice(2), undefined, {
      refusal: () => {
        throw new Error(SECRET_KEY);
      },
    });
    expect(kindOf(throwing)).toEqual(["REQUEST_REFUSED", "CALLER_REFUSAL", null]);
    // 429 and redirect stop the session.
    const r429 = harness();
    const f429 = await r429.resolve(notice(1), reply(() => "", 429)());
    expect(kindOf(f429)).toEqual(["TRANSPORT_FAILED", "HTTP_429_RECEIVED", null]);
    expect(r429.session.getStopReason()).toBe("HTTP_429_RECEIVED");
    expect(kindOf(await r429.resolve(notice(2)))).toEqual([
      "REQUEST_REFUSED",
      "REQUEST_SESSION_STOPPED",
      null,
    ]);
    const redirect = harness();
    const fr = await redirect.resolve(
      notice(1),
      reply(() => "", 302, { location: "/elsewhere" })(),
    );
    expect(kindOf(fr)).toEqual(["TRANSPORT_FAILED", "HTTP_REDIRECT_REJECTED", null]);
    expect(redirect.session.getStopReason()).toBe("HTTP_REDIRECT_REJECTED");
    // Session-owned pacing: the second request waits for the lane spacing.
    const paced = harness();
    paced.script.push(okSwap(1)(), okSwap(2)());
    paced.state.now += 2_500;
    const p1 = paced.adapter.resolve(notice(1));
    const p2 = paced.adapter.resolve(notice(2));
    expect((await p1).kind).toBe("RESOLVED_SWAPS");
    await flush();
    expect(paced.calls).toHaveLength(1);
    paced.advance(2_499);
    await flush();
    expect(paced.calls).toHaveLength(1);
    paced.advance(1);
    expect((await p2).kind).toBe("RESOLVED_SWAPS");
    const [a, b] = paced.ledger();
    expect(b!.dispatchedAtMs - a!.dispatchedAtMs).toBe(2_500);
  });

  it("T-06 (A6): cancellation before dispatch, while paced, and in flight; session stopped in flight", async () => {
    const before = harness();
    const c = new AbortController();
    c.abort();
    const f = await before.resolve(notice(1), undefined, { signal: c.signal });
    expect(kindOf(f)).toEqual(["REQUEST_REFUSED", "CALLER_CANCELLED", null]);
    expect(before.ledger()).toHaveLength(0);
    // The reservation is permanent even though nothing was sent.
    expect((await before.resolve(notice(1))).kind).toBe("DUPLICATE_NOTIFICATION");
    // Cancelled during the pacing wait: refused by the session, never counted.
    const paced = harness();
    paced.script.push(okSwap(1)());
    paced.state.now += 2_500;
    await paced.adapter.resolve(notice(1));
    const c2 = new AbortController();
    const p = paced.adapter.resolve(notice(2), { signal: c2.signal });
    await flush();
    c2.abort();
    expect(kindOf(await p)).toEqual(["REQUEST_REFUSED", "CALLER_CANCELLED", null]);
    expect(paced.ledger()).toHaveLength(1);
    // In flight.
    const inflight = harness();
    const c3 = new AbortController();
    inflight.script.push(hang());
    inflight.state.now += 2_500;
    const p3 = inflight.adapter.resolve(notice(1), { signal: c3.signal });
    await flush();
    expect(inflight.calls).toHaveLength(1);
    c3.abort();
    const f3 = await p3;
    expect(kindOf(f3)).toEqual(["CANCELLED_IN_FLIGHT", "CALLER_CANCELLED", null]);
    expect(f3.exchange).toMatchObject({ sessionError: "REQUEST_ABORTED", evidence: "VERIFIED" });
    // Session stopped in flight, with arbitrary stop text (fixed fallback code).
    const stop = harness();
    stop.script.push(hang());
    stop.state.now += 2_500;
    const p4 = stop.adapter.resolve(notice(1));
    await flush();
    stop.session.stop(`custom ${SECRET_KEY}`);
    const f4 = await p4;
    expect(kindOf(f4)).toEqual(["SESSION_STOPPED_IN_FLIGHT", "UNRECOGNIZED_SESSION_CODE", null]);
    expectSecretFree(f4);
    // Lifetime timer fires in flight.
    const life = harness();
    life.script.push(hang());
    life.state.now += 2_500;
    const p5 = life.adapter.resolve(notice(1));
    await flush();
    life.state.now = life.deadline();
    // Only the lifetime timer fires (the request timer is due too, but is left pending).
    const lifetimeTimer = [...life.timers.entries()].find(([, t]) => t.at === life.deadline());
    expect(lifetimeTimer).toBeDefined();
    life.timers.delete(lifetimeTimer![0]);
    lifetimeTimer![1].fn();
    expect(kindOf(await p5)).toEqual(["SESSION_STOPPED_IN_FLIGHT", "LIFETIME_EXPIRED", null]);
  });

  it("T-07 (A7): decoder outcomes map to facts; only RESOLVED_SWAPS can change a tracker", async () => {
    const h = harness();
    const none = await h.resolve(notice(1), rpcResult(txResult(signatureOf(1), [memoIx()]))());
    expect(kindOf(none)).toEqual(["RESOLVED_NO_TARGET_SWAP", null, null]);
    expect(none.decoder).toEqual({ status: "NO_MATCHING_SWAPS", reason: null, detail: null });
    expect(none.replay).toBe("DECODER_REPLAYABLE");
    const failedTx = txResult(signatureOf(2), [swapIx("BUY")]);
    failedTx.meta.err = { InstructionError: [0, { Custom: 6005 }] };
    const failed = await h.resolve(notice(2), rpcResult(failedTx)());
    expect(kindOf(failed)).toEqual(["RECORDED_FAILED_TRANSACTION", null, null]);
    const v = txResult(signatureOf(3), [swapIx("BUY")]);
    v.version = `v9-${"z".repeat(40)}`;
    const unresolved = await h.resolve(notice(3), rpcResult(v)());
    expect(kindOf(unresolved)).toEqual([
      "UNRESOLVED",
      "UNSUPPORTED_TRANSACTION_VERSION",
      "UNRECOGNIZED_DECODER_DETAIL",
    ]);
    const nv = txResult(signatureOf(4), [swapIx("BUY")]);
    delete nv.version;
    expect(kindOf(await h.resolve(notice(4), rpcResult(nv)()))).toEqual([
      "UNRESOLVED",
      "UNSUPPORTED_TRANSACTION_VERSION",
      "VERSION_MISSING",
    ]);
    const spy = {
      getPoolId: () => POOL.poolAddress,
      getTokenMint: () => POOL.candidateMint,
      ingestTrade: vi.fn(),
    } as unknown as RollingTradeFlowTracker;
    for (const f of [none, failed, unresolved]) {
      expect(f.ingestible).toBe(false);
      expect(f.events).toEqual([]);
      expect(h.adapter.ingest(f, spy)).toEqual({
        status: "NOT_INGESTIBLE",
        code: "FACT_NOT_INGESTIBLE",
        total: 0,
        accepted: 0,
        rejected: 0,
        unattempted: 0,
        rejections: [],
        stopCheck: null,
      });
    }
    expect(
      (spy as unknown as { ingestTrade: ReturnType<typeof vi.fn> }).ingestTrade,
    ).not.toHaveBeenCalled();
  });

  it("T-08 (A8): ingestion COMPLETE, deduplicated, identity-refused, PARTIAL and foreign facts", async () => {
    const h = harness();
    const one = await h.resolve(notice(1), okSwap(1)());
    const t = tracker();
    const first = h.adapter.ingest(one, t);
    expect(first).toMatchObject({
      status: "COMPLETE",
      code: null,
      total: 1,
      accepted: 1,
      rejected: 0,
      unattempted: 0,
    });
    expectPlainFrozen(first);
    expect(h.adapter.ingest(one, t)).toMatchObject({
      status: "NONE_ACCEPTED",
      total: 1,
      accepted: 0,
      rejected: 1,
      unattempted: 0,
      rejections: [{ eventId: one.events[0]!.eventId, reason: "DUPLICATE_EVENT" }],
    });
    for (const wrong of [
      tracker(FIXTURE_CPMM_TOKEN_0_VAULT),
      tracker(POOL.poolAddress, WSOL_MINT),
    ]) {
      expect(h.adapter.ingest(one, wrong)).toMatchObject({
        status: "REFUSED_BEFORE_START",
        code: "TRACKER_IDENTITY_MISMATCH",
        total: 1,
        accepted: 0,
        rejected: 0,
        unattempted: 1,
      });
    }
    // Two swaps; the first is already in the tracker: PARTIAL with exact counts.
    const two = await h.resolve(
      notice(2),
      okSwap(2, [swapIx("BUY"), swapIx("SELL", 2_500_000n, 900_000_000n)])(),
    );
    expect(two.events).toHaveLength(2);
    const t2 = tracker();
    expect(t2.ingestTrade(two.events[0]!).ok).toBe(true);
    expect(h.adapter.ingest(two, t2)).toMatchObject({
      status: "PARTIAL",
      total: 2,
      accepted: 1,
      rejected: 1,
      unattempted: 0,
    });
    // Copies and other instances' facts are foreign, even when marked ingestible.
    const fresh = tracker();
    expect(h.adapter.ingest({ ...one }, fresh)).toMatchObject({
      status: "NOT_INGESTIBLE",
      code: "FOREIGN_FACT",
      total: 0,
    });
    const other = harness();
    expect(other.adapter.ingest(one, fresh)).toMatchObject({
      status: "NOT_INGESTIBLE",
      code: "FOREIGN_FACT",
    });
    expect(h.adapter.ingest(one, fresh, { bogus: 1 } as never)).toMatchObject({
      status: "REFUSED_BEFORE_START",
      code: "INVALID_GATE",
      unattempted: 1,
    });
    expect(h.adapter.ingest(one, fresh).status).toBe("COMPLETE");
  });

  it("T-09 (A9): invalid notifications and gates are refused before any reservation or request", async () => {
    const h = harness();
    const getter = notice(1);
    Object.defineProperty(getter, "slot", { get: () => SLOT, enumerable: true });
    class Box {
      signature = signatureOf(1);
      slot = SLOT;
      receivedAtMs = RECEIVED_AT;
    }
    const missingReceipt = { ...notice(1) } as Record<string, unknown>;
    delete missingReceipt.receivedAtMs;
    const cases: [unknown, string][] = [
      [null, "NOTIFICATION_NOT_PLAIN_DATA"],
      [[notice(1)], "NOTIFICATION_NOT_PLAIN_DATA"],
      [new Box(), "NOTIFICATION_NOT_PLAIN_DATA"],
      [getter, "NOTIFICATION_NOT_PLAIN_DATA"],
      [notice(1, { provenance: "HOST_OBSERVED" }), "UNKNOWN_KEY"],
      [notice(1, { fallbackProvenance: "x" }), "UNKNOWN_KEY"],
      [notice(1, { signature: "not-base58-0OIl" }), "SIGNATURE_INVALID"],
      [notice(1, { signature: key(1) }), "SIGNATURE_INVALID"],
      [notice(1, { signature: ` ${signatureOf(1)}` }), "SIGNATURE_INVALID"],
      [notice(1, { slot: -1 }), "SLOT_INVALID"],
      [notice(1, { slot: 1.5 }), "SLOT_INVALID"],
      [notice(1, { slot: String(SLOT) }), "SLOT_INVALID"],
      [missingReceipt, "RECEIVED_AT_MISSING"],
      [notice(1, { receivedAtMs: 0 }), "RECEIVED_AT_INVALID"],
      [notice(1, { receivedAtMs: 1.5 }), "RECEIVED_AT_INVALID"],
      [notice(1, { blockTime: 0 }), "BLOCK_TIME_INVALID"],
      [notice(1, { blockTime: 1.5 }), "BLOCK_TIME_INVALID"],
      [notice(1, { blockTime: String(BLOCK_TIME) }), "BLOCK_TIME_INVALID"],
    ];
    for (const [n, code] of cases) {
      const f = await h.adapter.resolve(n);
      expect(kindOf(f), code).toEqual(["INVALID_NOTIFICATION", code, null]);
      expect(f.notification).toBeNull();
    }
    for (const gate of [{ signal: "x" }, { refusal: "x" }, { other: 1 }, []]) {
      const f = await h.adapter.resolve(notice(1), gate as never);
      expect(kindOf(f)).toEqual(["INVALID_GATE", "INVALID_GATE", null]);
    }
    expect(h.adapter.reservedSignatureCount).toBe(0);
    expect(h.ledger()).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect((await h.resolve(notice(1), okSwap(1)())).kind).toBe("RESOLVED_SWAPS");
  });

  it("T-10 (B1): missing evidence is explicit, keeps the genuine outcome, and never uses the response text", async () => {
    // The observer threw (the session swallows it): nothing was recorded.
    const threw = harness();
    threw.tap.fn = () => {
      throw new Error("observer failure");
    };
    const f = await threw.resolve(notice(1), okSwap(1)());
    expect(kindOf(f)).toEqual(["EVIDENCE_MISSING", "NOT_RECORDED", null]);
    expect(f.exchange).toMatchObject({
      evidence: "MISSING",
      evidenceDetail: "NOT_RECORDED",
      bodyState: "UNVERIFIED",
      httpStatus: 200,
      bodyComplete: true,
    });
    expect(f.exchange!.body.state).toBe("UNVERIFIED");
    expect(f.ingestible).toBe(false);
    expect(f.postAwaitCheck).toBeNull();
    // Transport and HTTP outcomes are kept, but the missing evidence is not shown as NOT_READ.
    const net = await threw.resolve(notice(2), networkError());
    expect(kindOf(net)).toEqual(["TRANSPORT_FAILED", "NETWORK_ERROR", "EVIDENCE_MISSING"]);
    expect(net.exchange).toMatchObject({
      evidence: "MISSING",
      bodyState: "UNVERIFIED",
      sessionError: "NETWORK_ERROR",
    });
    expect(net.exchange!.body.state).toBe("UNVERIFIED");
    const http = await threw.resolve(notice(3), reply(() => "{}", 503)());
    expect(kindOf(http)).toEqual(["HTTP_ERROR", "HTTP_STATUS_503", "EVIDENCE_MISSING"]);
    expect(http.exchange).toMatchObject({
      evidence: "MISSING",
      bodyState: "UNVERIFIED",
      httpStatus: 503,
    });
    // Overfull recorder.
    const full = harness({ maxPending: 1 });
    full.tap.fn = (e) => {
      full.recorder.observe({ ...e, entry: { ...e.entry, seq: 999 } });
      full.recorder.observe(e);
    };
    expect(kindOf(await full.resolve(notice(1), okSwap(1)()))).toEqual([
      "EVIDENCE_MISSING",
      "NOT_RECORDED",
      null,
    ]);
    expect(full.recorder.droppedCount).toBe(1);
    // Evidence taken twice (the second consumer finds nothing).
    const twice = harness();
    twice.tap.fn = (e) => {
      twice.recorder.observe(e);
      expect(twice.recorder.take(e.entry.seq).status).toBe("PRESENT");
    };
    expect(kindOf(await twice.resolve(notice(1), okSwap(1)()))).toEqual([
      "EVIDENCE_MISSING",
      "ALREADY_TAKEN",
      null,
    ]);
    // Duplicate evidence for one sequence number is a mismatch.
    const dup = harness();
    dup.tap.fn = (e) => {
      dup.recorder.observe(e);
      dup.recorder.observe(e);
    };
    expect(kindOf(await dup.resolve(notice(1), okSwap(1)()))).toEqual([
      "EVIDENCE_MISMATCH",
      "DUPLICATE_EVIDENCE",
      null,
    ]);
    // Divergence between the session's text and the evidence: the fact follows the evidence.
    const diverge = harness();
    diverge.tap.fn = (e) => {
      const other = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: e.entry.jsonRpcId,
          result: txResult(signatureOf(1), [memoIx()]),
        }),
      );
      diverge.recorder.observe({ ...e, body: other, observedBodyBytes: other.length });
    };
    expect((await diverge.resolve(notice(1), okSwap(1)())).kind).toBe("RESOLVED_NO_TARGET_SWAP");
    for (const x of [f, net, http]) expectPlainFrozen(x);
  });

  it("T-11 (B2): each binding field is checked; the recorder copies bytes before use", async () => {
    type Tamper = (e: PaperRequestExchangeEvidence) => PaperRequestExchangeEvidence;
    const entry =
      (over: Record<string, unknown>): Tamper =>
      (e) => ({ ...e, entry: { ...e.entry, ...over } });
    const cases: [string, string, Tamper][] = [
      ["EVIDENCE_MISSING", "NOT_RECORDED", entry({ seq: 77 })],
      ["EVIDENCE_MISMATCH", "ENTRY_LANE", entry({ lane: "RUGCHECK" })],
      ["EVIDENCE_MISMATCH", "ENTRY_OWNER", entry({ owner: "SPOT" })],
      ["EVIDENCE_MISSING", "NOT_RECORDED", entry({ purpose: "OTHER" })],
      [
        "EVIDENCE_MISMATCH",
        "ENTRY_REQUESTED_IDENTITY",
        entry({ requestedIdentity: POOL.poolAddress }),
      ],
      ["EVIDENCE_MISMATCH", "ENTRY_JSON_RPC_ID", entry({ jsonRpcId: 1 })],
      ["EVIDENCE_MISMATCH", "ENTRY_DISPATCHED_AT", entry({ dispatchedAtMs: 1 })],
      ["EVIDENCE_MISMATCH", "ENTRY_COMPLETED_AT", entry({ completedAtMs: 1 })],
      ["EVIDENCE_MISMATCH", "ENTRY_HTTP_STATUS", entry({ httpStatus: 201 })],
      ["EVIDENCE_MISMATCH", "ENTRY_BODY_COMPLETE", entry({ bodyComplete: false })],
      ["EVIDENCE_MISMATCH", "ENTRY_ERROR", entry({ error: "NETWORK_ERROR" })],
      ["EVIDENCE_MISMATCH", "METHOD", (e) => ({ ...e, method: "GET" })],
      ["EVIDENCE_MISMATCH", "REQUEST_BODY", (e) => ({ ...e, requestBody: `${e.requestBody} ` })],
      ["EVIDENCE_MISMATCH", "REQUEST_BODY", (e) => ({ ...e, requestBody: null })],
      ["EVIDENCE_MISMATCH", "MAX_RESPONSE_BYTES", (e) => ({ ...e, maxResponseBytes: 200_000 })],
      [
        "EVIDENCE_MISMATCH",
        "BODY_ACCOUNTING",
        (e) => ({ ...e, observedBodyBytes: (e.observedBodyBytes ?? 0) + 1 }),
      ],
      ["EVIDENCE_MISMATCH", "BODY_ACCOUNTING", (e) => ({ ...e, bodyState: "NOT_READ" })],
      ["EVIDENCE_MISMATCH", "BODY_ACCOUNTING", (e) => ({ ...e, bodyState: "PARTIAL_OVERFLOW" })],
      ["EVIDENCE_MISMATCH", "BODY_ACCOUNTING", (e) => ({ ...e, body: null })],
      ["EVIDENCE_MISMATCH", "BODY_STATE", (e) => ({ ...e, bodyState: "OTHER" as never })],
    ];
    const h = harness({ maxHttpAttempts: 40 });
    let n = 0;
    for (const [kind, code, tamper] of cases) {
      n++;
      h.tap.fn = (e) => h.recorder.observe(tamper(e));
      const f = await h.resolve(notice(n), okSwap(n)());
      expect(kindOf(f), code).toEqual([kind, code, null]);
      expect(f.exchange!.bodyState, code).toBe("UNVERIFIED");
      expect(f.exchange!.body.state, code).toBe("UNVERIFIED");
      expect(f.ingestible).toBe(false);
    }
    // The recorder copies on observe: mutating the session's Buffer afterwards changes nothing.
    h.tap.fn = (e) => {
      h.recorder.observe(e);
      e.body!.fill(0x20);
    };
    const copied = await h.resolve(notice(50), okSwap(50)());
    expect(copied.kind).toBe("RESOLVED_SWAPS");
    // The adapter copies after take: mutating the recorder's Buffer afterwards changes nothing.
    const held: { body: Buffer | null } = { body: null };
    h.tap.fn = (e) => h.recorder.observe(e);
    const take = h.recorder.take.bind(h.recorder);
    const spyRecorder = Object.assign(Object.create(null), {
      observe: h.recorder.observe,
      boundSession: h.session,
      droppedCount: 0,
      bind: () => undefined,
      take: (seq: number) => {
        const t = take(seq);
        if (t.status === "PRESENT") held.body = t.evidence.body;
        return t;
      },
    });
    const viaSpy = new RaydiumCpmmTransactionSourceAdapter({ ...h.options, evidence: spyRecorder });
    h.state.now += 2_500;
    h.script.push(okSwap(51)());
    const fact = await viaSpy.resolve(notice(51));
    const before = json(fact);
    expect(held.body).not.toBeNull();
    held.body!.fill(0);
    expect(json(fact)).toBe(before);
    expect(fact.exchange!.body.payload).toContain('"jsonrpc":"2.0"');
  });

  it("T-12 (B3): concurrent duplicates dispatch once; capacity is fixed; failures are not retried", async () => {
    const h = harness({ maxTracked: 2 });
    h.script.push(okSwap(1)());
    h.state.now += 2_500;
    const a = h.adapter.resolve(notice(1));
    const b = h.adapter.resolve({ ...notice(1) });
    const [fa, fb] = await Promise.all([a, b]);
    expect(fa.kind).toBe("RESOLVED_SWAPS");
    expect(kindOf(fb)).toEqual(["DUPLICATE_NOTIFICATION", "DUPLICATE_SIGNATURE", null]);
    expect(h.calls).toHaveLength(1);
    expect(h.ledger()).toHaveLength(1);
    expect(kindOf(await h.resolve(notice(2), networkError()))).toEqual([
      "TRANSPORT_FAILED",
      "NETWORK_ERROR",
      null,
    ]);
    expect(kindOf(await h.resolve(notice(3)))).toEqual([
      "TRACKING_CAPACITY_REACHED",
      "TRACKING_CAPACITY_REACHED",
      null,
    ]);
    expect((await h.resolve(notice(2))).kind).toBe("DUPLICATE_NOTIFICATION");
    expect(h.adapter.reservedSignatureCount).toBe(2);
    expect(h.calls).toHaveLength(2);
    expect(h.ledger()).toHaveLength(2);
  });

  it("T-13 (B4): only unchanged credential-free JSON is stored; detected or uncertain content is withheld", async () => {
    const MAX = 6_000;
    const h = harness({ maxResponseBytes: MAX, maxHttpAttempts: 40 });
    let n = 0;
    /** One extra log line; @@RAW@@ in it is replaced in the response bytes (after JSON encoding). */
    const withLog = async (line: string, raw = "") => {
      n++;
      const id0 = n;
      return h.resolve(
        notice(id0),
        reply((id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: txResult(signatureOf(id0), [swapIx("BUY")], [line]),
          }).replace("@@RAW@@", raw),
        )(),
      );
    };
    const esc = (s: string) =>
      [...s].map((c) => `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const pct = (s: string) =>
      [...s].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).join("");
    let nested = "%41";
    for (let i = 0; i < 6; i++) nested = nested.replace(/%/g, "%25");
    const prefix8 = SECRET_KEY.slice(0, 8);
    const withheld: [string, string, string, string][] = [
      ["literal key", `Program log: ${SECRET_KEY}`, "", "CREDENTIAL_MATERIAL"],
      ["eight-character prefix", `Program log: ${prefix8}`, "", "CREDENTIAL_MATERIAL"],
      ["prefix in other case", `Program log: ${prefix8.toUpperCase()}`, "", "CREDENTIAL_MATERIAL"],
      ["\\u-escaped in the raw bytes", "Program log: @@RAW@@", esc(prefix8), "CREDENTIAL_MATERIAL"],
      ["\\u text inside a parsed value", `Program log: ${esc(prefix8)}`, "", "CREDENTIAL_MATERIAL"],
      ["percent-encoded", `Program log: ${pct(prefix8)}`, "", "CREDENTIAL_MATERIAL"],
      ["URL prefix", "Program log: visit https://x", "", "CREDENTIAL_MATERIAL"],
      ["\\/-escaped URL prefix", "Program log: @@RAW@@", "https:\\/\\/x", "CREDENTIAL_MATERIAL"],
      [
        "quoted secret (parsed value only)",
        `Program log: ${QUOTED_SECRET}`,
        "",
        "CREDENTIAL_MATERIAL",
      ],
      ["nested beyond the bound", `Program log: ${nested}`, "", "CREDENTIAL_SCAN_INCONCLUSIVE"],
    ];
    for (const [label, line, raw, reason] of withheld) {
      const f = await withLog(line, raw);
      expect(kindOf(f), label).toEqual(["EVIDENCE_NOT_REPLAYABLE", reason, null]);
      expect(f.replay, label).toBe("NOT_REPLAYABLE");
      expect(f.decoder, label).toBeNull();
      expect(f.events, label).toEqual([]);
      expect(f.ingestible, label).toBe(false);
      expect(f.exchange!.body, label).toMatchObject({
        state: "WITHHELD",
        withheldReason: reason,
        payload: null,
      });
      expect(f.exchange!.body.sha256, label).toMatch(/^[0-9a-f]{64}$/);
      expectSecretFree(f);
      expectPlainFrozen(f);
    }
    // A key used as a JSON object key is found too.
    n++;
    const keyed = txResult(signatureOf(n), [swapIx("BUY")]);
    keyed.meta[SECRET_KEY] = 1;
    const fk = await h.resolve(notice(n), rpcResult(keyed)());
    expect(kindOf(fk)).toEqual(["EVIDENCE_NOT_REPLAYABLE", "CREDENTIAL_MATERIAL", null]);
    // Seven characters are below the reviewed threshold: stored and replayable.
    const seven = await withLog(`Program log: ${SECRET_KEY.slice(0, 7)}`);
    expect(seven.exchange!.body.state).toBe("STORED");
    expect(seven.kind).not.toBe("EVIDENCE_NOT_REPLAYABLE");
    // A partial body cut inside the key.
    n++;
    const head = `{"jsonrpc":"2.0","id":0,"x":"`;
    const cut = `${head}${"y".repeat(MAX - head.length - 10)}${SECRET_KEY}"}`;
    const partial = await h.resolve(notice(n), reply(() => cut)());
    expect(kindOf(partial)).toEqual(["TRANSPORT_FAILED", "RESPONSE_TOO_LARGE", null]);
    expect(partial.exchange!.body).toMatchObject({
      state: "WITHHELD",
      withheldReason: "PARTIAL_BODY",
      payload: null,
      retainedBytes: MAX,
      observedBytes: cut.length,
    });
    // Invalid UTF-8, unparsable JSON and a BOM: withheld entirely.
    n++;
    const badUtf8 = Buffer.concat([
      Buffer.from(`{"k":"${SECRET_KEY}`),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    const fu = await h.resolve(notice(n), reply(() => badUtf8)());
    expect(kindOf(fu)).toEqual(["MALFORMED_RESPONSE", "INVALID_UTF8", null]);
    expect(fu.exchange!.body).toMatchObject({
      state: "WITHHELD",
      payload: null,
      sha256: sha256(badUtf8),
    });
    n++;
    const fj = await h.resolve(notice(n), reply(() => `{"k":"${SECRET_KEY}"`)());
    expect(kindOf(fj)).toEqual(["MALFORMED_RESPONSE", "UNPARSABLE_JSON", null]);
    n++;
    const bom = await h.resolve(
      notice(n),
      reply(
        (id) =>
          `${String.fromCharCode(0xfeff)}${JSON.stringify({ jsonrpc: "2.0", id, result: txResult(signatureOf(n), [swapIx("BUY")]) })}`,
      )(),
    );
    expect(kindOf(bom)).toEqual(["MALFORMED_RESPONSE", "UNPARSABLE_JSON", null]);
    n++;
    const html = await h.resolve(notice(n), reply(() => `<html>${SECRET_KEY}</html>`, 502)());
    expect(kindOf(html)).toEqual(["HTTP_ERROR", "HTTP_STATUS_502", null]);
    expect(html.exchange!.body).toMatchObject({
      state: "WITHHELD",
      withheldReason: "UNPARSABLE_JSON",
    });
    n++;
    const rpcKey = await h.resolve(
      notice(n),
      reply((id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `bad key ${SECRET_KEY}` },
        }),
      )(),
    );
    expect(kindOf(rpcKey)).toEqual(["EVIDENCE_NOT_REPLAYABLE", "CREDENTIAL_MATERIAL", null]);
    expect(rpcKey.rpcErrorCode).toBeNull();
    for (const f of [fk, partial, fu, fj, bom, html, rpcKey]) {
      expectSecretFree(f);
      expectPlainFrozen(f);
      expect(f.ingestible).toBe(false);
    }
    // A clean body is stored unchanged and replays identically.
    n++;
    const clean = await h.resolve(notice(n), okSwap(n)());
    expect(clean.kind).toBe("RESOLVED_SWAPS");
    expect(clean.exchange!.body.state).toBe("STORED");
    expect(clean.exchange!.body.sha256).toBe(sha256(clean.exchange!.body.payload!));
    const again = decodeRaydiumCpmmTransactionSwaps(
      JSON.parse(clean.exchange!.body.payload!).result,
      POOL,
      { receiptTimestampMs: RECEIVED_AT },
    );
    expect(json(again.events)).toBe(json(clean.events));
  });

  it("T-14 (B5): session-owned deadline after completion, late refusal, and transport precedence", async () => {
    // The clock passes the deadline after completion; the lifetime timer has not fired.
    const clock = harness();
    clock.tap.fn = (e) => {
      clock.recorder.observe(e);
      clock.state.now = clock.deadline();
    };
    const late = await clock.resolve(notice(1), okSwap(1)());
    expect(kindOf(late)).toEqual(["LATE_RESPONSE", "ABSOLUTE_DEADLINE", null]);
    expect(late.postAwaitCheck).toMatchObject({
      passed: false,
      cause: "ABSOLUTE_DEADLINE",
      sessionState: "OPEN",
      atMs: clock.deadline(),
      deadlineMs: clock.deadline(),
    });
    expect(late.exchange!.completedAtMs!).toBeLessThan(clock.deadline());
    expect(late.exchange!.body.state).toBe("STORED");
    expect(late.decoder).toBeNull();
    expect(late.replay).toBe("NOT_DECODED");
    expect(late.ingestible).toBe(false);
    // The lifetime timer fires after completion: the session is stopped at the check.
    const timer = harness();
    timer.tap.fn = (e) => {
      timer.recorder.observe(e);
      timer.state.now = timer.deadline();
      timer.fireDue();
    };
    const stopped = await timer.resolve(notice(1), okSwap(1)());
    expect(kindOf(stopped)).toEqual(["LATE_RESPONSE", "SESSION_STOPPED", null]);
    expect(stopped.postAwaitCheck).toMatchObject({
      sessionState: "STOPPED",
      sessionStopReason: "LIFETIME_EXPIRED",
    });
    // The caller's refusal flips after completion.
    const flip = harness();
    let refuse = false;
    flip.tap.fn = (e) => {
      flip.recorder.observe(e);
      refuse = true;
    };
    const lr = await flip.resolve(notice(1), okSwap(1)(), {
      refusal: () => (refuse ? `late ${SECRET_KEY}` : null),
    });
    expect(kindOf(lr)).toEqual(["LATE_RESPONSE", "LIFECYCLE_REFUSED", null]);
    expect(lr.postAwaitCheck!.callerRefusal).toBe("CALLER_REFUSAL");
    expectSecretFree(lr);
    // The caller cancels after completion.
    const cancel = harness();
    const c = new AbortController();
    cancel.tap.fn = (e) => {
      cancel.recorder.observe(e);
      c.abort();
    };
    expect(kindOf(await cancel.resolve(notice(1), okSwap(1)(), { signal: c.signal }))).toEqual([
      "LATE_RESPONSE",
      "CALLER_CANCELLED",
      null,
    ]);
    // A 429, redirect or timeout coinciding with an expired deadline keeps its transport code.
    for (const [responder, code] of [
      [reply(() => "", 429)(), "HTTP_429_RECEIVED"],
      [reply(() => "", 307, { location: "/x" })(), "HTTP_REDIRECT_REJECTED"],
    ] as const) {
      const x = harness();
      x.tap.fn = (e) => {
        x.recorder.observe(e);
        x.state.now = x.deadline();
      };
      expect(kindOf(await x.resolve(notice(1), responder)), code).toEqual([
        "TRANSPORT_FAILED",
        code,
        null,
      ]);
    }
    const t = harness();
    t.tap.fn = (e) => {
      t.recorder.observe(e);
      t.state.now = t.deadline();
    };
    t.script.push(hang());
    t.state.now += 2_500;
    const p = t.adapter.resolve(notice(1));
    await flush();
    t.advance(10_000);
    const timedOut = await p;
    expect(t.session.isOpen()).toBe(true);
    expect(kindOf(timedOut)).toEqual(["TRANSPORT_FAILED", "REQUEST_TIMED_OUT", null]);
  });

  it("T-15 (B6): ingestion re-checks the lifecycle before every event with exact counts", async () => {
    const h = harness();
    const two = await h.resolve(
      notice(1),
      okSwap(1, [swapIx("BUY"), swapIx("SELL", 2_500_000n, 900_000_000n)])(),
    );
    expect(two.events).toHaveLength(2);
    // Refused before the first event.
    expect(h.adapter.ingest(two, tracker(), { refusal: () => "STOP" })).toMatchObject({
      status: "REFUSED_BEFORE_START",
      code: "LIFECYCLE_STOPPED",
      total: 2,
      accepted: 0,
      rejected: 0,
      unattempted: 2,
      stopCheck: { cause: "LIFECYCLE_REFUSED" },
    });
    const c = new AbortController();
    c.abort();
    expect(h.adapter.ingest(two, tracker(), { signal: c.signal })).toMatchObject({
      status: "REFUSED_BEFORE_START",
      unattempted: 2,
      stopCheck: { cause: "CALLER_CANCELLED" },
    });
    // Between events: one accepted, one unattempted.
    let calls = 0;
    const between = h.adapter.ingest(two, tracker(), {
      refusal: () => (++calls >= 2 ? "STOP" : null),
    });
    expect(between).toMatchObject({
      status: "PARTIAL",
      code: "LIFECYCLE_STOPPED",
      total: 2,
      accepted: 1,
      rejected: 0,
      unattempted: 1,
      stopCheck: { cause: "LIFECYCLE_REFUSED" },
    });
    // The first event is rejected, then the lifecycle stops: none accepted, one unattempted.
    const t = tracker();
    t.ingestTrade(two.events[0]!);
    let calls2 = 0;
    expect(
      h.adapter.ingest(two, t, { refusal: () => (++calls2 >= 2 ? "STOP" : null) }),
    ).toMatchObject({
      status: "NONE_ACCEPTED",
      accepted: 0,
      rejected: 1,
      unattempted: 1,
    });
    // The clock passes the deadline before ingestion (timer not fired), then the session stops.
    const saved = h.state.now;
    h.state.now = h.deadline();
    expect(h.adapter.ingest(two, tracker())).toMatchObject({
      status: "REFUSED_BEFORE_START",
      unattempted: 2,
      stopCheck: { cause: "ABSOLUTE_DEADLINE", sessionState: "OPEN" },
    });
    h.state.now = saved;
    h.session.stop();
    expect(h.adapter.ingest(two, tracker())).toMatchObject({
      status: "REFUSED_BEFORE_START",
      unattempted: 2,
      stopCheck: { cause: "SESSION_STOPPED", sessionStopReason: "SESSION_STOP_REQUESTED" },
    });
  });

  it("T-16: source boundaries (no network, timers, clock, budget, stop or response text)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./RaydiumCpmmTransactionSourceAdapter.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      /\bfetch\s*\(/,
      /setTimeout|setInterval|setImmediate/,
      /Date\.now/,
      /\.budget\b/,
      /\.stop\(/,
      /\.text\b/,
      /\.getStatus\(/,
      /process\.env/,
      /\.open\(/,
    ]) {
      expect(src, String(forbidden)).not.toMatch(forbidden);
    }
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:util",
      "./ExactPoolHistoryEnumerator.js",
      "./PaperRequestSession.js",
      "./RaydiumCpmmPoolStateAdapter.js",
      "./RaydiumCpmmSwapDecoder.js",
      "./RollingTradeFlowTracker.js",
    ]);
  });
  it("T-17 (review 1): large arrays within the response limit are scanned iteratively, never rejected", async () => {
    const MIB = 1_048_576;
    const h = harness({ maxResponseBytes: MIB, laneMaxResponseBytes: MIB });
    // Clean: a 150,000-element array (about 300 KB) is scanned in full and stored.
    const clean = txResult(signatureOf(1), [swapIx("BUY")]);
    clean.meta.extra = Array(150_000).fill(0);
    const fc = await h.resolve(notice(1), rpcResult(clean)());
    expect(fc.exchange!.body.observedBytes).toBeGreaterThan(300_000);
    expect(fc.exchange!.body.state).toBe("STORED");
    expect(fc.kind).toBe("RESOLVED_SWAPS");
    expect(fc.ingestible).toBe(true);
    // Credential-bearing: a secret visible only after parsing, in the middle of a large array.
    for (const [n, size] of [
      [2, 150_000],
      [3, 200_000],
    ] as const) {
      const dirty = txResult(signatureOf(n), [swapIx("BUY")]);
      const arr: unknown[] = Array(size).fill(0);
      arr[Math.floor(size / 2)] = `log ${QUOTED_SECRET}`;
      dirty.meta.extra = arr;
      const fd = await h.resolve(notice(n), rpcResult(dirty)());
      expect(kindOf(fd)).toEqual(["EVIDENCE_NOT_REPLAYABLE", "CREDENTIAL_MATERIAL", null]);
      expect(fd.exchange!.body).toMatchObject({ state: "WITHHELD", payload: null });
      expect(fd.ingestible).toBe(false);
      expectSecretFree(fd);
    }
    // Nested large arrays of strings are scanned too.
    const nested = txResult(signatureOf(4), [swapIx("BUY")]);
    nested.meta.extra = [Array(120_000).fill("a"), [Array(10).fill(`x ${QUOTED_SECRET}`)]];
    const fn = await h.resolve(notice(4), rpcResult(nested)());
    expect(kindOf(fn)).toEqual(["EVIDENCE_NOT_REPLAYABLE", "CREDENTIAL_MATERIAL", null]);
    // An object key visible only after parsing, inside a large array of objects.
    const keyed = txResult(signatureOf(5), [swapIx("BUY")]);
    const objs: Record<string, number>[] = Array.from({ length: 60_000 }, () => ({ a: 0 }));
    objs[30_000] = { [QUOTED_SECRET]: 0 };
    keyed.meta.extra = objs;
    const fk = await h.resolve(notice(5), rpcResult(keyed)());
    expect(kindOf(fk)).toEqual(["EVIDENCE_NOT_REPLAYABLE", "CREDENTIAL_MATERIAL", null]);
    expect(fk.exchange!.body.observedBytes).toBeGreaterThan(400_000);
    expect(h.ledger()).toHaveLength(5);
  });

  it("T-18 (review 2): own __proto__ keys stay visible to validation (no prototype setter)", async () => {
    const h = harness();
    const n = notice(1);
    // A normal notification plus an own __proto__ property.
    const extra = JSON.parse(`{${JSON.stringify(n).slice(1, -1)},"__proto__":{"x":1}}`);
    expect(Object.keys(extra)).toContain("__proto__");
    // Only receivedAtMs is a normal own key; the required fields sit under __proto__.
    const hidden = JSON.parse(
      `{"receivedAtMs":${RECEIVED_AT},"__proto__":${JSON.stringify({
        signature: n.signature,
        slot: n.slot,
        blockTime: n.blockTime,
      })}}`,
    );
    // Responders are queued so that a defective copier would dispatch and resolve.
    h.script.push(okSwap(1)(), okSwap(1)());
    for (const v of [extra, hidden]) {
      h.state.now += 2_500;
      const f = await h.adapter.resolve(v);
      expect(kindOf(f)).toEqual(["INVALID_NOTIFICATION", "UNKNOWN_KEY", null]);
      expect(f.notification).toBeNull();
    }
    // Required fields may not come from an inherited prototype either.
    const inherited = Object.create({ signature: n.signature, slot: n.slot }) as Record<
      string,
      unknown
    >;
    inherited.receivedAtMs = RECEIVED_AT;
    expect((await h.adapter.resolve(inherited)).kind).toBe("INVALID_NOTIFICATION");
    // The shared helper also guards gates, options and recorder limits.
    expect(kindOf(await h.adapter.resolve(notice(2), JSON.parse('{"__proto__":{}}')))).toEqual([
      "INVALID_GATE",
      "INVALID_GATE",
      null,
    ]);
    const opts = { ...h.options } as Record<string, unknown>;
    Object.defineProperty(opts, "__proto__", {
      value: { maxResponseBytes: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(
      () =>
        new RaydiumCpmmTransactionSourceAdapter(opts as unknown as CpmmTransactionSourceOptions),
    ).toThrow(/unsupported option __proto__/);
    expect(() =>
      createCpmmExchangeEvidenceRecorder(JSON.parse('{"maxPendingEvidence":1,"__proto__":{}}')),
    ).toThrow(/maxPendingEvidence/);
    expect(h.adapter.reservedSignatureCount).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.ledger()).toHaveLength(0);
  });

  it("T-19 (review 3): the caller's callback runs before fresh session, clock and signal reads", async () => {
    type Effect = "ABORT" | "STOP" | "DEADLINE";
    const cause = {
      ABORT: "CALLER_CANCELLED",
      STOP: "SESSION_STOPPED",
      DEADLINE: "ABSOLUTE_DEADLINE",
    } as const;
    const setup = () => {
      const h = harness();
      const c = new AbortController();
      const act = (e: Effect) => {
        if (e === "ABORT") c.abort();
        else if (e === "STOP") h.session.stop();
        else h.state.now = h.deadline();
      };
      return { h, c, act };
    };
    // Post-await check: the callback acts after completion and returns null.
    for (const e of ["ABORT", "STOP", "DEADLINE"] as const) {
      const { h, c, act } = setup();
      let completed = false;
      h.tap.fn = (ev) => {
        h.recorder.observe(ev);
        completed = true;
      };
      const f = await h.resolve(notice(1), okSwap(1)(), {
        signal: c.signal,
        refusal: () => {
          if (completed) act(e);
          return null;
        },
      });
      expect(kindOf(f), e).toEqual(["LATE_RESPONSE", cause[e], null]);
      expect(f.postAwaitCheck, e).toMatchObject({
        passed: false,
        cause: cause[e],
        callerRefusal: null,
      });
      expect(f.ingestible, e).toBe(false);
      expect(f.events, e).toEqual([]);
    }
    // Ingestion: the callback acts before the first event, or between events.
    for (const e of ["ABORT", "STOP", "DEADLINE"] as const) {
      for (const at of [1, 2]) {
        const { h, c, act } = setup();
        const two = await h.resolve(
          notice(1),
          okSwap(1, [swapIx("BUY"), swapIx("SELL", 2_500_000n, 900_000_000n)])(),
        );
        expect(two.ingestible).toBe(true);
        let calls = 0;
        const r = h.adapter.ingest(two, tracker(), {
          signal: c.signal,
          refusal: () => {
            if (++calls === at) act(e);
            return null;
          },
        });
        expect(r, `${e} at ${at}`).toMatchObject(
          at === 1
            ? { status: "REFUSED_BEFORE_START", total: 2, accepted: 0, rejected: 0, unattempted: 2 }
            : { status: "PARTIAL", total: 2, accepted: 1, rejected: 0, unattempted: 1 },
        );
        expect(r.code).toBe("LIFECYCLE_STOPPED");
        expect(r.stopCheck, `${e} at ${at}`).toMatchObject({ passed: false, cause: cause[e] });
      }
    }
    // A single-event fact: a callback that cancels is never reported COMPLETE.
    const { h, c } = setup();
    const one = await h.resolve(notice(1), okSwap(1)());
    const t = tracker();
    const r = h.adapter.ingest(one, t, {
      signal: c.signal,
      refusal: () => {
        c.abort();
        return null;
      },
    });
    expect(r).toMatchObject({ status: "REFUSED_BEFORE_START", accepted: 0, unattempted: 1 });
    expect(t.ingestTrade(one.events[0]!).ok).toBe(true);
  });

  it("T-20 (item 13, L22): getBinding() is the frozen, stable pool and mint identity only", async () => {
    const h = harness();
    const b = h.adapter.getBinding();
    expect(b).toEqual({ poolAddress: POOL.poolAddress, candidateMint: POOL.candidateMint });
    expect(Object.keys(b)).toEqual(["poolAddress", "candidateMint"]);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.getPrototypeOf(b)).toBe(Object.prototype);
    expect(h.adapter.getBinding()).toBe(b);
    expect(() => {
      (b as { poolAddress: string }).poolAddress = WSOL_MINT;
    }).toThrow(TypeError);
    expect(h.adapter.getBinding().poolAddress).toBe(POOL.poolAddress);
    expectSecretFree(b);
    // No request, reservation or session use.
    expect(h.calls).toHaveLength(0);
    expect(h.ledger()).toHaveLength(0);
    expect(h.adapter.reservedSignatureCount).toBe(0);
    // Resolution after reading the binding is unchanged.
    const f = await h.resolve(notice(1), okSwap(1)());
    expect(f.kind).toBe("RESOLVED_SWAPS");
    expect(h.adapter.getBinding()).toBe(b);
  });
  // --- G2: pure response analysis (shared with the live adapter) -------------------------------

  /** The analysis input for a response the live adapter received for notice(n) with `id`. */
  const analysisInput = (
    n: number,
    id: number,
    bytes: Uint8Array,
    extra: Record<string, unknown> = {},
  ) => ({
    notification: notice(n),
    jsonRpcId: id,
    pool: POOL,
    responseBytes: bytes,
    maxResponseBytes: 6_000,
    secrets: SECRETS,
    ...extra,
  });
  const outcomeOf = (a: ReturnType<typeof analyzeCpmmTransactionResponse>) => {
    if (a.status !== "ANALYZED") throw new Error(`not analyzed: ${a.code}`);
    return {
      kind: a.kind,
      code: a.code,
      detail: a.detail,
      rpcErrorCode: a.rpcErrorCode,
      decoder: a.decoder,
      events: a.events,
      replay: a.replay,
    };
  };
  const factOutcome = (f: CpmmResolutionFact) => ({
    kind: f.kind,
    code: f.code,
    detail: f.detail,
    rpcErrorCode: f.rpcErrorCode,
    decoder: f.decoder,
    events: f.events,
    replay: f.replay,
  });

  it("T-21 (G2): the pure analysis agrees with the live adapter on unchanged ids and bytes, for every response outcome", async () => {
    const h = harness({ maxResponseBytes: 6_000, maxHttpAttempts: 40 });
    const failedTx = (sig: string) => {
      const t = txResult(sig, [swapIx("BUY")]);
      t.meta.err = { InstructionError: [0, { Custom: 6005 }] };
      return t;
    };
    const unsupported = (sig: string) => {
      const t = txResult(sig, [swapIx("BUY")]);
      t.version = `v9-${"z".repeat(40)}`;
      return t;
    };
    const otherSlot = (sig: string) => ({ ...txResult(sig, [swapIx("BUY")]), slot: SLOT + 1 });
    const otherTime = (sig: string) => ({
      ...txResult(sig, [swapIx("BUY")]),
      blockTime: BLOCK_TIME + 1,
    });
    const noTime = (sig: string) => ({ ...txResult(sig, [swapIx("BUY")]), blockTime: null });
    const env = (id: number, v: Record<string, unknown>) =>
      JSON.stringify({ jsonrpc: "2.0", id, ...v });
    const cases: [string, (n: number, id: number) => string | Uint8Array, string][] = [
      [
        "swaps",
        (n, id) =>
          env(id, {
            result: txResult(signatureOf(n), [
              swapIx("BUY"),
              swapIx("SELL", 2_500_000n, 900_000_000n),
            ]),
          }),
        "RESOLVED_SWAPS",
      ],
      [
        "no target swap",
        (n, id) => env(id, { result: txResult(signatureOf(n), [memoIx()]) }),
        "RESOLVED_NO_TARGET_SWAP",
      ],
      [
        "failed transaction",
        (n, id) => env(id, { result: failedTx(signatureOf(n)) }),
        "RECORDED_FAILED_TRANSACTION",
      ],
      [
        "decoder unresolved",
        (n, id) => env(id, { result: unsupported(signatureOf(n)) }),
        "UNRESOLVED",
      ],
      [
        "rpc error (code only)",
        (_n, id) =>
          env(id, { error: { code: -32_004, message: `failed ${SECRET_KEY.slice(0, 3)}` } }),
        "RPC_ERROR",
      ],
      ["not found", (_n, id) => env(id, { result: null }), "TRANSACTION_NOT_FOUND"],
      [
        "id mismatch",
        (n, id) => env(id + 1, { result: txResult(signatureOf(n), [swapIx("BUY")]) }),
        "MALFORMED_RESPONSE",
      ],
      [
        "extra envelope key",
        (n, id) => env(id, { result: txResult(signatureOf(n), [swapIx("BUY")]), x: 1 }),
        "MALFORMED_RESPONSE",
      ],
      [
        "result and error",
        (_n, id) => env(id, { result: null, error: { code: 1, message: "m" } }),
        "MALFORMED_RESPONSE",
      ],
      ["invalid UTF-8", () => Uint8Array.from([0x7b, 0xff, 0x7d]), "MALFORMED_RESPONSE"],
      ["unparsable JSON", () => "{not json", "MALFORMED_RESPONSE"],
      [
        "different signature",
        (n, id) => env(id, { result: txResult(signatureOf(n + 100), [swapIx("BUY")]) }),
        "SIGNATURE_MISMATCH",
      ],
      [
        "slot mismatch",
        (n, id) => env(id, { result: otherSlot(signatureOf(n)) }),
        "METADATA_CONTRADICTION",
      ],
      [
        "block time mismatch",
        (n, id) => env(id, { result: otherTime(signatureOf(n)) }),
        "METADATA_CONTRADICTION",
      ],
      [
        "block time unavailable",
        (n, id) => env(id, { result: noTime(signatureOf(n)) }),
        "METADATA_CONTRADICTION",
      ],
      [
        "credential material",
        (n, id) =>
          env(id, {
            result: txResult(signatureOf(n), [swapIx("BUY")], [`Program log: ${SECRET_KEY}`]),
          }),
        "EVIDENCE_NOT_REPLAYABLE",
      ],
    ];
    let n = 0;
    for (const [label, make, kind] of cases) {
      n++;
      const live = await h.resolve(notice(n), reply((id) => make(n, id))());
      expect(live.kind, label).toBe(kind);
      const id = live.exchange!.jsonRpcId;
      const raw = make(n, id);
      const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
      const a = analyzeCpmmTransactionResponse(analysisInput(n, id, bytes));
      expect(outcomeOf(a), label).toEqual(factOutcome(live));
      expect(a.status === "ANALYZED" && a.body.sha256, label).toBe(live.exchange!.body.sha256);
      expect(a.status === "ANALYZED" && a.body.state, label).toBe(live.exchange!.body.state);
      expect(a.status === "ANALYZED" && a.body.withheldReason, label).toBe(
        live.exchange!.body.withheldReason,
      );
      expect(json(a), label).not.toContain(SECRET_KEY.slice(0, 8));
      expectPlainFrozen(a, label);
    }
  });

  it("T-22 (G2): mismatched ids, signatures and metadata change the analysis exactly as at runtime", async () => {
    const h = harness();
    const live = await h.resolve(notice(1), okSwap(1)());
    expect(live.kind).toBe("RESOLVED_SWAPS");
    const id = live.exchange!.jsonRpcId;
    const bytes = Buffer.from(live.exchange!.body.payload!, "utf8");
    const base = analyzeCpmmTransactionResponse(analysisInput(1, id, bytes));
    expect(outcomeOf(base)).toEqual(factOutcome(live));
    const variant = (extra: Record<string, unknown>) =>
      analyzeCpmmTransactionResponse(analysisInput(1, id, bytes, extra));
    const kc = (a: ReturnType<typeof analyzeCpmmTransactionResponse>) => [
      a.status === "ANALYZED" ? a.kind : a.status,
      a.code,
    ];
    expect(kc(variant({ jsonRpcId: id + 1 }))).toEqual(["MALFORMED_RESPONSE", "ID_MISMATCH"]);
    expect(kc(variant({ notification: notice(2) }))).toEqual([
      "SIGNATURE_MISMATCH",
      "SIGNATURE_DIFFERENT",
    ]);
    expect(kc(variant({ notification: notice(1, { slot: SLOT + 1 }) }))).toEqual([
      "METADATA_CONTRADICTION",
      "SLOT_MISMATCH",
    ]);
    expect(kc(variant({ notification: notice(1, { blockTime: BLOCK_TIME + 1 }) }))).toEqual([
      "METADATA_CONTRADICTION",
      "BLOCK_TIME_MISMATCH",
    ]);
    // No notified blockTime: nothing to compare (as at runtime).
    expect(kc(variant({ notification: notice(1, { blockTime: null }) }))).toEqual([
      "RESOLVED_SWAPS",
      null,
    ]);
    // A different receipt time changes only the receipt timestamp of the decoded events.
    const later = variant({ notification: notice(1, { receivedAtMs: RECEIVED_AT + 7 }) });
    expect(later.status === "ANALYZED" && later.events[0]!.receiptTimestampMs).toBe(
      RECEIVED_AT + 7,
    );
    // A different pool context is a different decoder context.
    const otherPool = { ...POOL, poolAddress: key(77) } as RaydiumCpmmPoolStateSuccess;
    const pooled = variant({ pool: otherPool });
    expect(pooled.status === "ANALYZED" ? pooled.kind : pooled.code).not.toBe("RESOLVED_SWAPS");
    // Changed bytes that stay valid JSON are analysed as what they now say (here, another slot).
    const tampered = Buffer.from(
      bytes.toString("utf8").replace(`"slot":${SLOT}`, `"slot":${SLOT + 2}`),
    );
    expect(kc(variant({ responseBytes: tampered }))).toEqual([
      "METADATA_CONTRADICTION",
      "SLOT_MISMATCH",
    ]);
  });

  it("T-23 (G2): public inputs are validated safely and bounded before any copy", () => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 5, result: null }));
    const ok = analysisInput(1, 5, bytes);
    expect(analyzeCpmmTransactionResponse(ok)).toMatchObject({
      status: "ANALYZED",
      kind: "TRANSACTION_NOT_FOUND",
      scope: "RESPONSE_VALIDATION_AND_DECODING_ONLY",
      notProven: CPMM_RESPONSE_ANALYSIS_NOT_PROVEN,
    });
    const traps = { n: 0 };
    const counting = <T extends object>(t: T): T =>
      new Proxy(t, {
        get: (o, k, r) => (traps.n++, Reflect.get(o, k, r)),
        ownKeys: (o) => (traps.n++, Reflect.ownKeys(o)),
        getOwnPropertyDescriptor: (o, k) => (traps.n++, Reflect.getOwnPropertyDescriptor(o, k)),
        getPrototypeOf: (o) => (traps.n++, Reflect.getPrototypeOf(o)),
      });
    let getterRuns = 0;
    const withGetter = { ...ok };
    Object.defineProperty(withGetter, "jsonRpcId", {
      get: () => (getterRuns++, 5),
      enumerable: true,
    });
    const secretsGetter = [...SECRETS];
    Object.defineProperty(secretsGetter, 0, { get: () => (getterRuns++, RPC_URL) });
    const { secrets: _omit, ...missingSecrets } = ok;
    void _omit;
    const shadowed = Buffer.from(bytes);
    Object.defineProperty(shadowed, "byteLength", { value: 1 });
    Object.defineProperty(shadowed, "length", { value: 1 });
    const cases: [unknown, string][] = [
      [null, "INPUT_NOT_PLAIN_DATA"],
      ["x", "INPUT_NOT_PLAIN_DATA"],
      [[ok], "INPUT_NOT_PLAIN_DATA"],
      [counting({ ...ok }), "INPUT_NOT_PLAIN_DATA"],
      [withGetter, "INPUT_NOT_PLAIN_DATA"],
      [{ ...ok, extra: 1 }, "INPUT_UNKNOWN_KEY"],
      [missingSecrets, "INPUT_MISSING_KEY"],
      [{ ...ok, notification: counting(notice(1)) }, "NOTIFICATION_NOT_PLAIN_DATA"],
      [{ ...ok, notification: { ...notice(1), signature: "x" } }, "SIGNATURE_INVALID"],
      [{ ...ok, notification: { ...notice(1), receivedAtMs: 0 } }, "RECEIVED_AT_INVALID"],
      [{ ...ok, notification: { ...notice(1), blockTime: 1.5 } }, "BLOCK_TIME_INVALID"],
      [{ ...ok, notification: { ...notice(1), x: 1 } }, "UNKNOWN_KEY"],
      [{ ...ok, jsonRpcId: 0 }, "JSON_RPC_ID_INVALID"],
      [{ ...ok, jsonRpcId: 1.5 }, "JSON_RPC_ID_INVALID"],
      [{ ...ok, jsonRpcId: "5" }, "JSON_RPC_ID_INVALID"],
      [{ ...ok, pool: {} }, "POOL_CONTEXT_INVALID"],
      [{ ...ok, pool: counting({ ...POOL }) }, "POOL_CONTEXT_INVALID"],
      [{ ...ok, secrets: [] }, "SECRETS_INVALID"],
      [{ ...ok, secrets: ["short"] }, "SECRETS_INVALID"],
      [{ ...ok, secrets: RPC_URL }, "SECRETS_INVALID"],
      [{ ...ok, secrets: counting([...SECRETS]) }, "SECRETS_INVALID"],
      [{ ...ok, secrets: secretsGetter }, "SECRETS_INVALID"],
      [{ ...ok, maxResponseBytes: 0 }, "MAX_RESPONSE_BYTES_INVALID"],
      [
        { ...ok, maxResponseBytes: CPMM_MAX_ANALYSIS_RESPONSE_BYTES + 1 },
        "MAX_RESPONSE_BYTES_INVALID",
      ],
      [{ ...ok, maxResponseBytes: "9" }, "MAX_RESPONSE_BYTES_INVALID"],
      [{ ...ok, responseBytes: "{}" }, "RESPONSE_BYTES_INVALID"],
      [{ ...ok, responseBytes: bytes.buffer }, "RESPONSE_BYTES_INVALID"],
      [{ ...ok, responseBytes: new Uint16Array(4) }, "RESPONSE_BYTES_INVALID"],
      [{ ...ok, responseBytes: counting(Buffer.from(bytes)) }, "RESPONSE_BYTES_INVALID"],
      [{ ...ok, maxResponseBytes: bytes.length - 1 }, "RESPONSE_EXCEEDS_LIMIT"],
    ];
    for (const [input, code] of cases) {
      const r = analyzeCpmmTransactionResponse(input);
      expect(r, code).toEqual({
        status: "INPUT_INVALID",
        code,
        scope: "RESPONSE_VALIDATION_AND_DECODING_ONLY",
      });
      expect(Object.isFrozen(r)).toBe(true);
    }
    expect(traps.n).toBe(0);
    expect(getterRuns).toBe(0);
    // Exactly at the limit is analysed; a shadowed length is ignored (the genuine bytes are used).
    expect(analyzeCpmmTransactionResponse({ ...ok, maxResponseBytes: bytes.length }).status).toBe(
      "ANALYZED",
    );
    const sh = analyzeCpmmTransactionResponse({ ...ok, responseBytes: shadowed });
    expect(sh.status === "ANALYZED" && sh.body.retainedBytes).toBe(bytes.length);
    // Only the view's own bytes are read.
    const framed = Buffer.concat([Buffer.from("XX"), bytes, Buffer.from("YY")]);
    const view = framed.subarray(2, 2 + bytes.length);
    const v = analyzeCpmmTransactionResponse({ ...ok, responseBytes: view });
    expect(v.status === "ANALYZED" && v.body.sha256).toBe(sha256(bytes));
    // The caller's buffer is copied: later mutation does not reach the result.
    const mutable = Buffer.from(bytes);
    const before = analyzeCpmmTransactionResponse({ ...ok, responseBytes: mutable });
    mutable.fill(0x20);
    expect(before.status === "ANALYZED" && before.kind).toBe("TRANSACTION_NOT_FOUND");
  });

  it("T-24 (G2): an analysis is never a trusted fact; ingest() refuses it, and a late runtime outcome is not a mismatch", async () => {
    const h = harness();
    // The clock passes the session deadline after completion: the runtime outcome is LATE_RESPONSE.
    h.tap.fn = (e) => {
      h.recorder.observe(e);
      h.state.now = h.deadline();
    };
    const late = await h.resolve(notice(1), okSwap(1)());
    expect(kindOf(late)).toEqual(["LATE_RESPONSE", "ABSOLUTE_DEADLINE", null]);
    const bytes = Buffer.from(late.exchange!.body.payload!, "utf8");
    const a = analyzeCpmmTransactionResponse(analysisInput(1, late.exchange!.jsonRpcId, bytes));
    // The same bytes decode: the analysis proves validation and decoding only, not freshness.
    expect(a.status === "ANALYZED" && a.kind).toBe("RESOLVED_SWAPS");
    expect(a.status === "ANALYZED" && a.notProven).toContain("FRESHNESS_AND_LIFECYCLE");
    expect(Object.keys(a)).not.toContain("ingestible");
    // ingest() refuses the analysis and any fact-shaped copy of it, before touching the tracker.
    const spy = {
      getPoolId: () => POOL.poolAddress,
      getTokenMint: () => POOL.candidateMint,
      ingestTrade: vi.fn(),
    } as unknown as RollingTradeFlowTracker;
    const forged = { ...(a as object), ingestible: true, replay: "DECODER_REPLAYABLE" };
    for (const candidate of [a, forged, JSON.parse(json(a))]) {
      expect(h.adapter.ingest(candidate as unknown as CpmmResolutionFact, spy)).toMatchObject({
        status: "NOT_INGESTIBLE",
        code: "FOREIGN_FACT",
        total: 0,
      });
    }
    expect(
      (spy as unknown as { ingestTrade: ReturnType<typeof vi.fn> }).ingestTrade,
    ).not.toHaveBeenCalled();
    // The analysis made no request, reservation or session use.
    expect(h.calls).toHaveLength(1);
    expect(h.adapter.reservedSignatureCount).toBe(1);
    expect(h.ledger()).toHaveLength(1);
  });
  /** A valid swap response for notice(1) with id 7, and the matching analysis input. */
  const swapCase = () => {
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: txResult(signatureOf(1), [swapIx("BUY")]) }),
    );
    return analysisInput(1, 7, bytes);
  };

  it("T-25 (G2 review): the pool context is validated and snapshotted without running caller code", () => {
    // The ordinary context still analyses (and the caller's pool object is neither frozen nor changed).
    const callerPool = structuredCloneable(POOL);
    const ordinary = analyzeCpmmTransactionResponse({ ...swapCase(), pool: callerPool });
    expect(ordinary.status === "ANALYZED" && ordinary.kind).toBe("RESOLVED_SWAPS");
    expect(Object.isFrozen(callerPool)).toBe(false);
    expect(Object.isFrozen(callerPool.verification)).toBe(false);
    expect(callerPool).toEqual(POOL);

    let runs = 0;
    const traps = { n: 0 };
    const counting = <T extends object>(t: T): T =>
      new Proxy(t, {
        get: (o, k, r) => (traps.n++, Reflect.get(o, k, r)),
        has: (o, k) => (traps.n++, Reflect.has(o, k)),
        ownKeys: (o) => (traps.n++, Reflect.ownKeys(o)),
        getOwnPropertyDescriptor: (o, k) => (traps.n++, Reflect.getOwnPropertyDescriptor(o, k)),
        getPrototypeOf: (o) => (traps.n++, Reflect.getPrototypeOf(o)),
      });
    const okGetter = structuredCloneable(POOL) as unknown as Record<string, unknown>;
    Object.defineProperty(okGetter, "ok", { get: () => (runs++, true), enumerable: true });
    const flagGetter = structuredCloneable(POOL);
    Object.defineProperty(flagGetter.verification, "ownerVerified", {
      get: () => (runs++, true),
      enumerable: true,
    });
    const nestedProxy = {
      ...structuredCloneable(POOL),
      verification: counting({ ...POOL.verification }),
    };
    const addressGetter = structuredCloneable(POOL) as unknown as Record<string, unknown>;
    Object.defineProperty(addressGetter, "baseVaultAddress", {
      get: () => (runs++, POOL.baseVaultAddress),
      enumerable: true,
    });
    const unconsumedGetter = structuredCloneable(POOL) as unknown as Record<string, unknown>;
    Object.defineProperty(unconsumedGetter, "lpSupply", {
      get: () => (runs++, 1n),
      enumerable: true,
    });
    const symbolKey = { ...structuredCloneable(POOL), [Symbol("x")]: 1 };
    const classPool = Object.assign(Object.create({ inherited: 1 }), structuredCloneable(POOL));
    const arrayVerification = {
      ...structuredCloneable(POOL),
      verification: [true, true, true, true],
    };
    for (const [label, pool] of [
      ["ok getter", okGetter],
      ["verification flag getter", flagGetter],
      ["verification proxy", nestedProxy],
      ["consumed address getter", addressGetter],
      ["unconsumed field getter", unconsumedGetter],
      ["symbol key", symbolKey],
      ["non-plain prototype", classPool],
      ["array verification", arrayVerification],
    ] as const) {
      const r = analyzeCpmmTransactionResponse({ ...swapCase(), pool });
      expect(r, label).toEqual({
        status: "INPUT_INVALID",
        code: "POOL_CONTEXT_INVALID",
        scope: "RESPONSE_VALIDATION_AND_DECODING_ONLY",
      });
    }
    expect(runs).toBe(0);
    expect(traps.n).toBe(0);
    // The accepted live constructor is unchanged: it still accepts the ordinary context.
    expect(() => harness()).not.toThrow();
  });

  it("T-26 (G2 review): revoked proxies in every input position are refused with fixed codes", () => {
    const revoked = <T extends object>(t: T): T => {
      const r = Proxy.revocable(t, {});
      r.revoke();
      return r.proxy;
    };
    const base = swapCase();
    const cases: [unknown, string][] = [
      [{ ...base, secrets: revoked([...SECRETS]) }, "SECRETS_INVALID"],
      [revoked({ ...base }), "INPUT_NOT_PLAIN_DATA"],
      [{ ...base, notification: revoked(notice(1)) }, "NOTIFICATION_NOT_PLAIN_DATA"],
      [{ ...base, pool: revoked({ ...POOL }) }, "POOL_CONTEXT_INVALID"],
      [
        {
          ...base,
          pool: { ...structuredCloneable(POOL), verification: revoked({ ...POOL.verification }) },
        },
        "POOL_CONTEXT_INVALID",
      ],
      [{ ...base, responseBytes: revoked(Buffer.from("{}")) }, "RESPONSE_BYTES_INVALID"],
      [{ ...base, jsonRpcId: revoked({}) }, "JSON_RPC_ID_INVALID"],
      [{ ...base, maxResponseBytes: revoked({}) }, "MAX_RESPONSE_BYTES_INVALID"],
    ];
    for (const [input, code] of cases) {
      let r: unknown;
      expect(() => {
        r = analyzeCpmmTransactionResponse(input);
      }, code).not.toThrow();
      expect(r, code).toEqual({
        status: "INPUT_INVALID",
        code,
        scope: "RESPONSE_VALIDATION_AND_DECODING_ONLY",
      });
    }
    // The valid input still analyses.
    const ok = analyzeCpmmTransactionResponse(base);
    expect(ok.status === "ANALYZED" && ok.kind).toBe("RESOLVED_SWAPS");
  });

  it("T-27 (G2 review 2): every consumed pool field must hold its primitive type before anything is frozen", () => {
    let runs = 0;
    let traps = 0;
    const MARKER = "SYNTHETIC_MARKER_ERROR";
    const withGetter = () => {
      const o: Record<string, unknown> = { a: 1 };
      Object.defineProperty(o, "g", { get: () => (runs++, true), enumerable: true });
      return o;
    };
    const withThrowingGetter = () => {
      const o: Record<string, unknown> = {};
      Object.defineProperty(o, "boom", {
        get: () => {
          runs++;
          throw new Error(MARKER);
        },
        enumerable: true,
      });
      return o;
    };
    const countingProxy = () =>
      new Proxy(
        { a: 1 },
        {
          get: (o, k, r) => (traps++, Reflect.get(o, k, r)),
          ownKeys: (o) => (traps++, Reflect.ownKeys(o)),
          getOwnPropertyDescriptor: (o, k) => (traps++, Reflect.getOwnPropertyDescriptor(o, k)),
          getPrototypeOf: (o) => (traps++, Reflect.getPrototypeOf(o)),
          isExtensible: (o) => (traps++, Reflect.isExtensible(o)),
          preventExtensions: (o) => (traps++, Reflect.preventExtensions(o)),
          defineProperty: (o, k, d) => (traps++, Reflect.defineProperty(o, k, d)),
        },
      );
    const revoked = () => {
      const r = Proxy.revocable({ a: 1 }, {});
      r.revoke();
      return r.proxy;
    };
    /** Wrong-type values for one field; `primitive` is a wrong primitive for that field. */
    const wrongValues = (primitive: unknown): [string, () => unknown, boolean][] => [
      ["object", () => ({ nested: 1 }), true],
      ["object with getter", withGetter, true],
      ["object with throwing getter", withThrowingGetter, true],
      ["array", () => [1, 2], true],
      ["function", () => () => 1, true],
      ["counting proxy", countingProxy, false],
      ["revoked proxy", revoked, false],
      ["wrong primitive", () => primitive, false],
      ["null", () => null, false],
      ["undefined", () => undefined, false],
    ];
    const poolFields: [string, unknown][] = [
      ["ok", "true"],
      ["poolAddress", 1],
      ["candidateMint", 1],
      ["wsolMint", 1],
      ["orientation", 1],
      ["baseDecimals", "6"],
      ["quoteDecimals", 9n],
      ["baseVaultAddress", 1],
      ["quoteVaultAddress", 1],
    ];
    const flagFields: [string, unknown][] = [
      ["ownerVerified", 1],
      ["vaultAuthoritiesVerified", "true"],
      ["tokenProgramsVerified", 1],
      ["authBumpVerified", 1],
    ];
    let checked = 0;
    for (const [where, fields] of [
      ["pool", poolFields],
      ["verification", flagFields],
    ] as const) {
      for (const [field, primitive] of fields) {
        for (const [label, make, checkFrozen] of wrongValues(primitive)) {
          const value = make();
          const pool = structuredCloneable(POOL) as unknown as Record<string, unknown>;
          const target = where === "pool" ? pool : (pool.verification as Record<string, unknown>);
          target[field] = value;
          let r: unknown;
          let thrown: unknown = null;
          try {
            r = analyzeCpmmTransactionResponse({ ...swapCase(), pool });
          } catch (e) {
            thrown = e;
          }
          const name = `${where}.${field} = ${label}`;
          expect(thrown, name).toBeNull();
          expect(r, name).toEqual({
            status: "INPUT_INVALID",
            code: "POOL_CONTEXT_INVALID",
            scope: "RESPONSE_VALIDATION_AND_DECODING_ONLY",
          });
          if (checkFrozen) expect(Object.isFrozen(value), name).toBe(false);
          expect(Object.isFrozen(pool), name).toBe(false);
          expect(Object.isFrozen(pool.verification), name).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBe((poolFields.length + flagFields.length) * 10);
    expect(runs).toBe(0);
    expect(traps).toBe(0);
    // The ordinary context still analyses, and nothing of the caller's is frozen.
    const callerPool = structuredCloneable(POOL);
    const ordinary = analyzeCpmmTransactionResponse({ ...swapCase(), pool: callerPool });
    expect(ordinary.status === "ANALYZED" && ordinary.kind).toBe("RESOLVED_SWAPS");
    expect(Object.isFrozen(callerPool)).toBe(false);
    expect(Object.isFrozen(callerPool.verification)).toBe(false);
    expect(Object.isFrozen(callerPool.verification.slotProvenance)).toBe(false);
  });
});

/** A structural copy of a pool context (bigints kept) whose nested objects are fresh. */
function structuredCloneable(pool: RaydiumCpmmPoolStateSuccess): RaydiumCpmmPoolStateSuccess {
  return {
    ...pool,
    verification: { ...pool.verification, slotProvenance: { ...pool.verification.slotProvenance } },
  };
}
