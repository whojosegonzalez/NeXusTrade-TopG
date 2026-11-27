/**
 * Bounded exact-pool CPMM notification collector: synthetic offline tests (§8.38.17 item 14).
 *
 * Frames are local literal bytes with injected receipt times; there is no transport, socket or
 * network. The handoff group (N13) also uses the item 13 harness: a real PaperRequestSession with
 * a virtual clock and timers, a scripted in-memory fetch, a real recorder, adapter, tracker and
 * ledger, with a fake owner that wires collector results to the ledger.
 */
import { createHash } from "node:crypto";
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
  CPMM_FRAME_DISPOSITIONS,
  CpmmPoolNotificationCollector,
  cpmmCollectorSaturatingAdd,
  type CpmmCollectorLimits,
  type CpmmFrameResult,
} from "./CpmmPoolNotificationCollector.js";
import {
  CpmmResolutionAccountingLedger,
  type CpmmAccountingWindow,
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
const BINDING = { poolAddress: POOL.poolAddress, candidateMint: POOL.candidateMint };

interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
  children?: Ix[];
  logData?: string[];
}

function swapIx(): Ix {
  const inAmount = 1_000_000_000n;
  const outAmount = 2_500_000n;
  const inVault = POOL.quoteVaultAddress;
  const outVault = POOL.baseVaultAddress;
  const inMint = WSOL_MINT;
  const outMint = POOL.candidateMint;
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
      USER_WSOL,
      USER_TOKEN,
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
        accounts: [USER_WSOL, inMint, inVault, PAYER],
        data: tc(inAmount, 9),
      },
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [outVault, outMint, USER_TOKEN, RAYDIUM_CPMM_AUTHORITY],
        data: tc(outAmount, POOL.baseDecimals),
      },
    ],
  };
}

const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const BT_MS = BLOCK_TIME * 1000;
const OBS_START = 1_794_829_400_000;
const RECEIVED_AT = 1_794_829_421_500;
const TRACKER_NOW = 1_794_829_422_000;

function txResult(sig: string, failed = false): Loose {
  const top = [swapIx()];
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
const REQ = 7;
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const ackFrame = (id: number = REQ, result: unknown = SUB) => enc({ jsonrpc: "2.0", id, result });
interface NotifOpts {
  sub?: unknown;
  sig?: unknown;
  slot?: unknown;
  err?: unknown;
  logs?: unknown;
  ctxExtra?: Record<string, unknown>;
  valueExtra?: Record<string, unknown>;
  omitErr?: boolean;
}
const notifObj = (o: NotifOpts = {}) => ({
  jsonrpc: "2.0",
  method: "logsNotification",
  params: {
    subscription: o.sub ?? SUB,
    result: {
      context: { slot: o.slot ?? SLOT, ...o.ctxExtra },
      value: {
        signature: o.sig ?? signatureOf(1),
        ...(o.omitErr ? {} : { err: o.err === undefined ? null : o.err }),
        logs: o.logs === undefined ? ["Program log: swap"] : o.logs,
        ...o.valueExtra,
      },
    },
  },
});
const notif = (o: NotifOpts = {}) => enc(notifObj(o));

const LIMITS: CpmmCollectorLimits = {
  maxFrameBytes: 4_096,
  maxEpochFrames: 64,
  maxEpochBytes: 65_536,
  maxRetainedFrameRecords: 256,
  maxRetainedNotifications: 64,
  maxEpochs: 4,
};

function collector(over: Partial<CpmmCollectorLimits> = {}, open = true) {
  const c = new CpmmPoolNotificationCollector({
    binding: BINDING,
    limits: { ...LIMITS, ...over },
    commitment: "confirmed",
  });
  let at = OBS_START;
  let epoch = 1;
  if (open) {
    const r = c.openEpoch({ epoch: 1, observationStartMs: OBS_START, subscribeRequestId: REQ });
    expect(r.status).toBe("OPENED");
  }
  return {
    c,
    setEpoch(e: number) {
      epoch = e;
    },
    /** One frame with an increasing injected receipt time. */
    frame(bytes: Uint8Array, o: { epoch?: number; at?: number } = {}): CpmmFrameResult {
      at = o.at ?? at + 10;
      return c.acceptFrame({ epoch: o.epoch ?? epoch, bytes, receivedAtMs: at });
    },
    ack() {
      return this.frame(ackFrame());
    },
  };
}

const disp = (r: CpmmFrameResult) => [
  r.disposition,
  r.blocking,
  r.status === "RECORDED" ? r.code : null,
];

function expectPlainFrozen(v: unknown, path = "value"): void {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
  expect(typeof v, path).toBe("object");
  expect(Object.isFrozen(v), path).toBe(true);
  for (const [k, x] of Object.entries(v as object)) expectPlainFrozen(x, `${path}.${k}`);
}

/** N14: every conservation equation, for the listed epochs. */
function expectConserved(c: CpmmPoolNotificationCollector, epochs: number[], envelopes = -1) {
  const k = c.counters();
  let frames = 0;
  let notes = 0;
  for (const e of epochs) {
    const r = c.epochReport(e);
    if (!r) continue;
    const sum = CPMM_FRAME_DISPOSITIONS.reduce((s, d) => s + r.byDisposition[d], 0);
    expect(r.frames, `epoch ${e}`).toBe(sum);
    expect(r.notificationsAccepted).toBe(r.byDisposition.NOTIFICATION_ACCEPTED);
    const m = r.metadataRetention;
    expect(m.frameRecordsRetained + m.frameRecordsDropped).toBe(r.frames);
    expect(m.notificationRecordsRetained + m.notificationRecordsDropped).toBe(
      r.notificationsAccepted,
    );
    expect(m.complete).toBe(m.frameRecordsDropped === 0 && m.notificationRecordsDropped === 0);
    frames += r.frames;
    notes += r.notificationsAccepted;
  }
  expect(k.frames).toBe(frames + k.unattributedFrames);
  expect(k.notificationsAccepted).toBe(notes);
  const m = k.metadataRetention;
  expect(m.frameRecordsRetained + m.frameRecordsDropped).toBe(k.frames);
  expect(m.notificationRecordsRetained + m.notificationRecordsDropped).toBe(
    k.notificationsAccepted,
  );
  expect(c.frameRecords().length).toBe(m.frameRecordsRetained);
  expect(c.notifications().length).toBe(m.notificationRecordsRetained);
  if (envelopes >= 0) expect(k.notificationsAccepted).toBe(envelopes);
}

// --- ledger harness (item 13 pattern) --------------------------------------------------------------

type Responder = (req: { id: number; signal: AbortSignal }) => Promise<Response>;
const rpcResult =
  (result: unknown): Responder =>
  async ({ id }) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
function held() {
  let id = 0;
  let resolve!: (r: Response) => void;
  const responder: Responder = (req) =>
    new Promise<Response>((res, rej) => {
      id = req.id;
      resolve = res;
      req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  return {
    responder,
    result: (result: unknown) =>
      resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 })),
  };
}

function ledgerHarness() {
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
      lifetimeMs: 600_000,
      maxHttpAttempts: 40,
      requestTimeoutMs: 10_000,
      lanes: {
        SOLANA_RPC: lane(40, 2_500, 200_000),
        RUGCHECK: lane(0, 1, 1),
        SOLANA_TRACKER: lane(0, 1, 1),
        DEXSCREENER: lane(0, 1, 1),
      },
    },
    clock: () => state.now,
    timers: T,
    onExchangeComplete: (e: PaperRequestExchangeEvidence) => recorder.observe(e),
  });
  recorder.bind(session);
  session.open();
  const adapter = new RaydiumCpmmTransactionSourceAdapter({
    pool: POOL,
    session,
    evidence: recorder,
    rpcUrl: RPC_URL,
    secrets: [RPC_URL, SECRET_KEY],
    maxTrackedSignatures: 32,
    maxResponseBytes: 100_000,
    maxSupportedTransactionVersion: 0,
  });
  const tracker = new RollingTradeFlowTracker({
    poolId: POOL.poolAddress,
    tokenMint: POOL.candidateMint,
    trackingStartedMs: OBS_START,
    clock: () => TRACKER_NOW,
  });
  const ledger = new CpmmResolutionAccountingLedger({
    binding: adapter.getBinding(),
    adapter,
    tracker,
    limits: { maxSignatureRecords: 16, maxDuplicateDetailsPerRecord: 4, maxEpochs: 4 },
  });
  return {
    state,
    session,
    adapter,
    tracker,
    ledger,
    script,
    dispatches: () => session.getStatus().ledger.length,
    account(e: CpmmNotificationEnvelope, responder?: Responder, gate?: CpmmLifecycleGate) {
      state.now += 2_500;
      if (responder) script.push(responder);
      return ledger.account(e, gate);
    },
  };
}

const WINDOW: CpmmAccountingWindow = {
  epoch: 1,
  windowStartMs: BT_MS - 30_000,
  windowEndMs: BT_MS + 30_000,
  cutoff: { slot: SLOT + 100, blockTimeMs: BT_MS + 60_000, provenance: "ON_CHAIN_BLOCK_TIME" },
  receiptFrontierMs: RECEIVED_AT + 1_000,
};

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/** The proposed conjunction for the future owner and reconciliation. */
function eligible(h: ReturnType<typeof ledgerHarness>, c: CpmmPoolNotificationCollector) {
  const s = h.ledger.summarize(WINDOW);
  if (s.status !== "SUMMARY") throw new Error(s.code);
  const r = c.epochReport(1)!;
  return {
    ledgerComplete: s.summary.accountingComplete,
    collectionClean: r.collectionClean,
    eligible: s.summary.accountingComplete && r.collectionClean,
    summary: s.summary,
  };
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM pool notification collector (synthetic, offline)", () => {
  it("N1: construction, degenerate bindings and byte-exact subscribe/unsubscribe frames", () => {
    const make = (over: Record<string, unknown>) => () =>
      new CpmmPoolNotificationCollector({
        binding: BINDING,
        limits: LIMITS,
        commitment: "confirmed",
        ...over,
      } as never);
    expect(make({})).not.toThrow();
    expect(make({ commitment: "processed" })).toThrow(/commitment/);
    expect(make({ extra: 1 })).toThrow(/exactly/);
    expect(make({ limits: { ...LIMITS, maxEpochs: 0 } })).toThrow(/maxEpochs/);
    expect(make({ limits: { ...LIMITS, extra: 1 } })).toThrow(/limits/);
    const missing = Object.fromEntries(
      Object.entries(LIMITS).filter(([k]) => k !== "maxFrameBytes"),
    );
    expect(make({ limits: missing })).toThrow(/limits/);
    for (const binding of [
      { poolAddress: RAYDIUM_CPMM_PROGRAM_ID, candidateMint: CANDIDATE_A },
      { poolAddress: "11111111111111111111111111111111", candidateMint: CANDIDATE_A },
      { poolAddress: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", candidateMint: CANDIDATE_A },
      { poolAddress: POOL.poolAddress, candidateMint: WSOL_MINT },
      { poolAddress: SPL_TOKEN_PROGRAM_ID, candidateMint: CANDIDATE_A },
      { poolAddress: CANDIDATE_A, candidateMint: CANDIDATE_A },
      { poolAddress: ` ${POOL.poolAddress}`, candidateMint: CANDIDATE_A },
      { poolAddress: "not-base58!", candidateMint: CANDIDATE_A },
      { ...BINDING, extra: 1 },
    ]) {
      expect(make({ binding }), JSON.stringify(binding)).toThrow(/\[CPMM_COLLECTOR_INIT\]/);
    }
    const { c } = collector({}, false);
    const opened = c.openEpoch({
      epoch: 1,
      observationStartMs: OBS_START,
      subscribeRequestId: REQ,
    });
    if (opened.status !== "OPENED") throw new Error("not opened");
    const expected =
      `{"jsonrpc":"2.0","id":7,"method":"logsSubscribe","params":[{"mentions":["${POOL.poolAddress}"]},` +
      `{"commitment":"confirmed"}]}`;
    expect(new TextDecoder().decode(opened.subscribeFrame)).toBe(expected);
    expect(Object.isFrozen(opened)).toBe(true);
    // Mutating the returned bytes changes nothing inside the collector.
    opened.subscribeFrame.fill(0);
    // Unsubscribe: only after acknowledgement, a different ID, at most once.
    expect(c.unsubscribeFrame(1, 8)).toBeNull();
    c.acceptFrame({ epoch: 1, bytes: ackFrame(), receivedAtMs: OBS_START + 1 });
    expect(c.unsubscribeFrame(1, REQ)).toBeNull();
    expect(c.unsubscribeFrame(1, 0)).toBeNull();
    const u = c.unsubscribeFrame(1, 8)!;
    expect(new TextDecoder().decode(u)).toBe(
      `{"jsonrpc":"2.0","id":8,"method":"logsUnsubscribe","params":[${SUB}]}`,
    );
    expect(c.unsubscribeFrame(1, 9)).toBeNull();
    u.fill(0);
    expect(c.epochReport(1)).toMatchObject({
      subscription: "ACKNOWLEDGED",
      subscriptionId: SUB,
      unsubscribe: { status: "BUILT_UNOBSERVED", requestId: 8 },
    });
    for (const f of [opened.subscribeFrame, u]) {
      expect(new TextDecoder().decode(f)).not.toContain(SECRET_KEY);
    }
  });

  it("N2: acknowledgement binds only the subscribe request ID; others never rebind", () => {
    const h = collector();
    expect(disp(h.frame(ackFrame(99)))).toEqual(["MISMATCHED_RESPONSE_ID", true, null]);
    expect(disp(h.ack())).toEqual(["SUBSCRIBE_ACKNOWLEDGED", false, null]);
    expect(disp(h.frame(ackFrame(REQ, 555)))).toEqual(["DUPLICATE_RESPONSE", true, "SUBSCRIBE"]);
    expect(h.c.epochReport(1)).toMatchObject({ subscriptionId: SUB, collectionClean: false });
    // Rejection.
    const r = collector();
    const err = enc({ jsonrpc: "2.0", id: REQ, error: { code: -32601, message: "no" } });
    expect(disp(r.frame(err))).toEqual(["SUBSCRIBE_REJECTED", true, null]);
    expect(disp(r.ack())).toEqual(["DUPLICATE_RESPONSE", true, "SUBSCRIBE"]);
    expect(r.c.epochReport(1)).toMatchObject({ subscription: "REJECTED", subscriptionId: null });
    // Malformed acknowledgements: consumed, never bound, later acknowledgements are duplicates.
    for (const bad of [
      enc({ jsonrpc: "2.0", id: REQ, result: -1 }),
      enc({ jsonrpc: "2.0", id: REQ, result: 1.5 }),
      enc({ jsonrpc: "2.0", id: REQ, result: "4242" }),
      enc({ jsonrpc: "2.0", id: REQ, result: SUB, extra: 1 }),
      enc({ jsonrpc: "2.0", id: REQ, error: { code: "x", message: "y" } }),
    ]) {
      const m = collector();
      expect(m.frame(bad).disposition).toBe("MALFORMED_MESSAGE");
      expect(m.ack().disposition).toBe("DUPLICATE_RESPONSE");
      expect(m.c.epochReport(1)).toMatchObject({
        subscription: "MALFORMED_RESPONSE",
        subscriptionId: null,
        collectionClean: false,
      });
    }
    // String ID equal in text is not the request ID.
    const s = collector();
    expect(s.frame(enc({ jsonrpc: "2.0", id: "7", result: SUB })).disposition).toBe(
      "MISMATCHED_RESPONSE_ID",
    );
    // Unsubscribe acknowledgement observed, then a duplicate.
    const u = collector();
    u.ack();
    u.c.unsubscribeFrame(1, 8);
    expect(u.frame(enc({ jsonrpc: "2.0", id: 8, result: true })).disposition).toBe(
      "UNSUBSCRIBE_ACKNOWLEDGED",
    );
    expect(u.frame(enc({ jsonrpc: "2.0", id: 8, result: true })).disposition).toBe(
      "DUPLICATE_RESPONSE",
    );
    expect(u.c.epochReport(1)!.unsubscribe.status).toBe("ACKNOWLEDGED");
    const v = collector();
    v.ack();
    v.c.unsubscribeFrame(1, 8);
    expect(disp(v.frame(enc({ jsonrpc: "2.0", id: 8, result: false })))).toEqual([
      "UNSUBSCRIBE_REJECTED",
      false,
      null,
    ]);
    expect(v.c.epochReport(1)).toMatchObject({
      unsubscribe: { status: "REJECTED" },
      collectionClean: true,
    });
  });

  it("N3: pre-acknowledgement and foreign-subscription notifications are blocking and never forwarded", () => {
    const h = collector();
    const pre = h.frame(notif());
    expect(disp(pre)).toEqual(["PRE_ACK_NOTIFICATION", true, null]);
    expect(pre.status).toBe("RECORDED");
    h.ack();
    const foreign = h.frame(notif({ sub: SUB + 1 }));
    expect(disp(foreign)).toEqual(["FOREIGN_SUBSCRIPTION", true, null]);
    expect(h.c.epochReport(1)).toMatchObject({
      notificationsAccepted: 0,
      blockingFrames: 3 - 1,
      collectionClean: false,
    });
    // A later acknowledgement never cleans a dirty epoch.
    expect(h.c.epochReport(1)!.collectionClean).toBe(false);
  });

  it("N4: extraction is signature, context.slot and injected receipt only; strict shapes", () => {
    const h = collector();
    h.ack();
    const r = h.frame(notif({ sig: signatureOf(3), slot: SLOT + 5 }), { at: RECEIVED_AT });
    if (r.status !== "ACCEPTED_NOTIFICATION") throw new Error(r.disposition);
    expect(r.envelope).toEqual({
      notification: { signature: signatureOf(3), slot: SLOT + 5, receivedAtMs: RECEIVED_AT },
      epoch: 1,
      hostReceivedAtMs: RECEIVED_AT,
    });
    expect(Object.keys(r.envelope.notification as object)).toEqual([
      "signature",
      "slot",
      "receivedAtMs",
    ]);
    expect(r.notification).toMatchObject({
      sequence: 1,
      epoch: 1,
      subscriptionId: SUB,
      notifiedTransactionError: "NULL",
    });
    expect(r.blocking).toBe(false);
    expectPlainFrozen(r);
    expect(h.frame(notif({ ctxExtra: { apiVersion: "2.0.15" } })).disposition).toBe(
      "NOTIFICATION_ACCEPTED",
    );
    expect(h.frame(notif({ logs: null })).disposition).toBe("NOTIFICATION_ACCEPTED");
    const bad: [NotifOpts | Record<string, unknown>, string][] = [
      [{ ctxExtra: { blockTime: BLOCK_TIME } }, "CONTEXT_KEYS"],
      [{ ctxExtra: { apiVersion: 2 } }, "API_VERSION_INVALID"],
      [{ valueExtra: { blockTime: BLOCK_TIME } }, "VALUE_KEYS"],
      [{ omitErr: true }, "VALUE_KEYS"],
      [{ sig: "not-a-signature" }, "SIGNATURE_INVALID"],
      [{ slot: -1 }, "SLOT_INVALID"],
      [{ slot: 1.5 }, "SLOT_INVALID"],
      [{ logs: [1] }, "LOGS_INVALID"],
      [{ sub: "4242" }, "SUBSCRIPTION_INVALID"],
    ];
    for (const [o, code] of bad) {
      expect(disp(h.frame(notif(o as NotifOpts))), code).toEqual([
        "MALFORMED_NOTIFICATION",
        true,
        code,
      ]);
    }
    expect(h.frame(enc({ ...notifObj(), id: 1 })).disposition).toBe("MALFORMED_MESSAGE");
    expect(h.frame(enc({ ...notifObj(), extra: 1 })).status).toBe("RECORDED");
    expect(h.frame(enc({ ...notifObj(), method: "slotNotification" })).disposition).toBe(
      "UNEXPECTED_METHOD",
    );
    expect(h.frame(enc({ ...notifObj(), jsonrpc: "1.0" })).disposition).toBe("MALFORMED_MESSAGE");
    expect(h.c.epochReport(1)!.notificationsAccepted).toBe(3);
  });

  it("N5: a transaction-error claim is forwarded, retained as PRESENT and blocks collectionClean", () => {
    const h = collector();
    h.ack();
    const r = h.frame(notif({ err: { InstructionError: [0, { Custom: 1 }] } }));
    if (r.status !== "ACCEPTED_NOTIFICATION") throw new Error(r.disposition);
    expect(r.blocking).toBe(true);
    expect(r.notification.notifiedTransactionError).toBe("PRESENT");
    expect(r.envelope.notification).toEqual({
      signature: signatureOf(1),
      slot: SLOT,
      receivedAtMs: r.notification.receivedAtMs,
    });
    expect(JSON.stringify(h.c.notifications())).not.toContain("InstructionError");
    expect(h.c.epochReport(1)).toMatchObject({
      notificationsAccepted: 1,
      notificationsWithTransactionError: 1,
      blockingFrames: 1,
      collectionClean: false,
    });
    // A string error is also a claim.
    expect(h.frame(notif({ sig: signatureOf(2), err: "x" })).blocking).toBe(true);
  });

  it("N6: acquisition limits are checked before hashing or decoding and latch for the epoch", () => {
    const parse = vi.spyOn(JSON, "parse");
    const h = collector({ maxFrameBytes: 200, maxEpochFrames: 4, maxEpochBytes: 600 });
    h.ack();
    const big = new Uint8Array(201).fill(0x7b);
    const parsedBefore = parse.mock.calls.length;
    expect(disp(h.frame(big))).toEqual(["OVERSIZE_FRAME", true, null]);
    expect(parse.mock.calls.length).toBe(parsedBefore);
    expect(h.c.frameRecords().at(-1)).toMatchObject({ byteLength: 201, sha256: null });
    // Latched: a valid notification is no longer decoded or forwarded.
    const after = h.frame(notif());
    expect([after.status, after.disposition]).toEqual(["RECORDED", "EPOCH_LIMIT_EXCEEDED"]);
    expect(parse.mock.calls.length).toBe(parsedBefore);
    expect(h.c.epochReport(1)).toMatchObject({
      acquisitionLimitLatched: true,
      frames: 3,
      bytes: ackFrame().byteLength + 201 + notif().byteLength,
      notificationsAccepted: 0,
      collectionClean: false,
    });
    // Exact boundaries: a frame of exactly maxFrameBytes is accepted.
    const e = collector({ maxFrameBytes: notif().byteLength });
    e.ack();
    expect(e.frame(notif()).disposition).toBe("NOTIFICATION_ACCEPTED");
    // Frame count: the fourth frame is accepted, the fifth latches.
    const f = collector({ maxEpochFrames: 4 });
    f.ack();
    for (let i = 0; i < 3; i++) {
      expect(f.frame(notif({ sig: signatureOf(i + 1) })).disposition).toBe("NOTIFICATION_ACCEPTED");
    }
    expect(disp(f.frame(notif({ sig: signatureOf(9) })))).toEqual([
      "EPOCH_LIMIT_EXCEEDED",
      true,
      "FRAMES",
    ]);
    expect(f.frame(ackFrame(99)).status === "RECORDED" && f.c.epochReport(1)!.frames).toBe(6);
    // Bytes: exactly at the limit is accepted, one byte over latches.
    const size = ackFrame().byteLength + notif().byteLength;
    const g = collector({ maxEpochBytes: size });
    g.ack();
    expect(g.frame(notif()).disposition).toBe("NOTIFICATION_ACCEPTED");
    expect(disp(g.frame(new Uint8Array(1)))).toEqual(["EPOCH_LIMIT_EXCEEDED", true, "BYTES"]);
    expect(g.frame(notif({ sig: signatureOf(2) })).disposition).toBe("EPOCH_LIMIT_EXCEEDED");
    expectConserved(g.c, [1]);
  });

  it("N7: malformed payloads and malformed frame envelopes are classified, blocking and never thrown", () => {
    const h = collector();
    h.ack();
    expect(disp(h.frame(Uint8Array.from([0xff, 0xfe])))).toEqual(["INVALID_UTF8", true, null]);
    expect(
      h.frame(enc(`${String.fromCharCode(0xfeff)}${JSON.stringify(notifObj())}`)).disposition,
    ).toBe("NOT_JSON");
    expect(h.frame(enc("not json")).disposition).toBe("NOT_JSON");
    expect(h.frame(enc("[1,2]")).disposition).toBe("MALFORMED_MESSAGE");
    expect(h.frame(enc("null")).disposition).toBe("MALFORMED_MESSAGE");
    expect(
      h.frame(enc(`{"__proto__":{"x":1},${JSON.stringify(notifObj()).slice(1)}`)).disposition,
    ).toBe("MALFORMED_NOTIFICATION");
    expect(h.frame(enc({ jsonrpc: "2.0" })).disposition).toBe("MALFORMED_MESSAGE");
    expect(h.frame(enc({ jsonrpc: "2.0", id: 5, method: "x" })).disposition).toBe(
      "MALFORMED_MESSAGE",
    );
    // Malformed frame envelopes: unattributed, never thrown, never decoded.
    const parse = vi.spyOn(JSON, "parse");
    const before = parse.mock.calls.length;
    const proxied = new Proxy(notif(), {});
    const getter = Object.defineProperty({ bytes: notif(), receivedAtMs: OBS_START + 1 }, "epoch", {
      get: () => 1,
      enumerable: true,
    });
    for (const bad of [
      null,
      undefined,
      42,
      {},
      { epoch: 1, bytes: notif(), receivedAtMs: OBS_START + 1, extra: 1 },
      { epoch: 1, bytes: JSON.stringify(notifObj()), receivedAtMs: OBS_START + 1 },
      { epoch: 1, bytes: [...notif()], receivedAtMs: OBS_START + 1 },
      { epoch: 1, bytes: new DataView(notif().buffer), receivedAtMs: OBS_START + 1 },
      { epoch: 1, bytes: proxied, receivedAtMs: OBS_START + 1 },
      { epoch: -1, bytes: notif(), receivedAtMs: OBS_START + 1 },
      getter,
    ]) {
      let r: CpmmFrameResult | undefined;
      expect(() => {
        r = h.c.acceptFrame(bad as never);
      }).not.toThrow();
      expect(r!.disposition, String(bad)).toBe("FRAME_INVALID");
      expect(r!.epoch).toBeNull();
      expect(r!.blocking).toBe(true);
    }
    expect(parse.mock.calls.length).toBe(before);
    expect(h.c.counters().unattributedFrames).toBe(11);
    expect(h.c.epochReport(1)!.collectionClean).toBe(false);
    // Only the supplied range is read: an ack embedded in a larger buffer.
    const g = collector();
    const ack = ackFrame();
    const backing = new Uint8Array(ack.byteLength + 10).fill(0x20);
    backing.set(ack, 5);
    backing[0] = 0xff;
    backing[backing.length - 1] = 0xff;
    expect(g.frame(backing.subarray(5, 5 + ack.byteLength)).disposition).toBe(
      "SUBSCRIBE_ACKNOWLEDGED",
    );
    // A Buffer view is accepted.
    expect(g.frame(Buffer.from(JSON.stringify(notifObj()))).disposition).toBe(
      "NOTIFICATION_ACCEPTED",
    );
    expectConserved(h.c, [1]);
  });

  it("N8: invalid receipts are refused before decoding", () => {
    const parse = vi.spyOn(JSON, "parse");
    const h = collector();
    h.ack();
    const before = parse.mock.calls.length;
    for (const at of [0, -5, 1.5, OBS_START - 1]) {
      expect(h.c.acceptFrame({ epoch: 1, bytes: notif(), receivedAtMs: at }).disposition).toBe(
        "RECEIPT_INVALID",
      );
    }
    expect(h.frame(notif(), { at: RECEIVED_AT }).disposition).toBe("NOTIFICATION_ACCEPTED");
    const after = parse.mock.calls.length;
    expect(h.frame(notif(), { at: RECEIVED_AT - 1 }).disposition).toBe("RECEIPT_INVALID");
    expect(parse.mock.calls.length).toBe(after);
    expect(after - before).toBe(1);
    expect(h.frame(notif(), { at: RECEIVED_AT }).disposition).toBe("NOTIFICATION_ACCEPTED");
    expect(h.c.epochReport(1)!.byDisposition.RECEIPT_INVALID).toBe(5);
  });

  it("N9: epochs are strictly increasing; supersession preserves an earlier terminal cause", () => {
    const h = collector();
    h.ack();
    expect(h.c.closeEpoch(1, "TRANSPORT_CLOSED", RECEIVED_AT)).toBe(true);
    // Superseding an already closed epoch keeps its cause.
    expect(
      h.c.openEpoch({ epoch: 2, observationStartMs: OBS_START, subscribeRequestId: REQ }),
    ).toMatchObject({ status: "OPENED" });
    expect(h.c.epochReport(1)).toMatchObject({
      state: "CLOSED",
      closeReason: "TRANSPORT_CLOSED",
      closedAtMs: RECEIVED_AT,
    });
    // A refused open closes the open epoch with SUPERSEDED.
    expect(
      h.c.openEpoch({ epoch: 2, observationStartMs: OBS_START, subscribeRequestId: REQ }),
    ).toEqual({ status: "REFUSED", code: "EPOCH_NOT_INCREASING" });
    expect(h.c.epochReport(2)).toMatchObject({ state: "CLOSED", closeReason: "SUPERSEDED" });
    expect(h.c.openEpoch({ epoch: 3 } as never)).toEqual({
      status: "REFUSED",
      code: "EPOCH_INVALID",
    });
    // Stale and unopened frames.
    expect(disp(h.frame(notif(), { epoch: 1 }))).toEqual(["STALE_EPOCH", true, null]);
    expect(h.frame(notif(), { epoch: 2 }).disposition).toBe("STALE_EPOCH");
    const un = h.frame(notif(), { epoch: 9 });
    expect([un.disposition, un.epoch]).toEqual(["EPOCH_NOT_OPEN", null]);
    expect(h.c.epochReport(1)!.byDisposition.STALE_EPOCH).toBe(1);
    // Capacity.
    const cap = collector({ maxEpochs: 1 });
    expect(
      cap.c.openEpoch({ epoch: 2, observationStartMs: OBS_START, subscribeRequestId: REQ }),
    ).toEqual({ status: "REFUSED", code: "EPOCH_CAPACITY" });
    expect(cap.c.epochReport(1)!.closeReason).toBe("SUPERSEDED");
    expect(cap.c.counters().openEpochRefused).toBe(1);
    expectConserved(h.c, [1, 2]);
  });

  it("N10: close reasons; the first terminal cause is permanent and dirtiness is monotonic", () => {
    for (const reason of [
      "TRANSPORT_CLOSED",
      "TRANSPORT_ERROR",
      "CANCELLED",
      "ACK_TIMEOUT",
      "KEEPALIVE_TIMEOUT",
      "LIMIT_EXCEEDED",
      "SUPERSEDED",
    ] as const) {
      const h = collector();
      h.ack();
      expect(h.c.epochReport(1)!.collectionClean).toBe(true);
      expect(h.c.closeEpoch(1, reason, RECEIVED_AT)).toBe(true);
      expect(h.c.epochReport(1)!.collectionClean, reason).toBe(false);
      // Repeated and later cleanup closes never replace the cause or clean the epoch.
      const v = h.c.version;
      expect(h.c.closeEpoch(1, "OWNER_CLOSED", RECEIVED_AT + 1)).toBe(false);
      expect(h.c.closeEpoch(1, reason, RECEIVED_AT + 2)).toBe(false);
      expect(h.c.version).toBe(v);
      expect(h.c.epochReport(1)).toMatchObject({
        closeReason: reason,
        closedAtMs: RECEIVED_AT,
        collectionClean: false,
      });
      // A late acknowledgement or notification is stale and never cleans.
      expect(h.frame(ackFrame()).disposition).toBe("STALE_EPOCH");
      expect(h.c.epochReport(1)!.collectionClean).toBe(false);
    }
    const ok = collector();
    ok.ack();
    ok.frame(notif());
    ok.c.unsubscribeFrame(1, 8);
    ok.frame(enc({ jsonrpc: "2.0", id: 8, result: true }));
    expect(ok.c.closeEpoch(1, "OWNER_CLOSED", RECEIVED_AT)).toBe(true);
    expect(ok.c.epochReport(1)).toMatchObject({
      collectionClean: true,
      unsubscribe: { status: "ACKNOWLEDGED" },
    });
    // A frame after a clean close makes it dirty for good.
    expect(ok.frame(notif()).disposition).toBe("STALE_EPOCH");
    expect(ok.c.epochReport(1)!.collectionClean).toBe(false);
    expect(ok.c.closeEpoch(1, "OWNER_CLOSED", RECEIVED_AT + 5)).toBe(false);
    expect(ok.c.epochReport(1)!.collectionClean).toBe(false);
    // Invalid close requests change nothing.
    const x = collector();
    expect(x.c.closeEpoch(1, "WHATEVER" as never, RECEIVED_AT)).toBe(false);
    expect(x.c.closeEpoch(1, "OWNER_CLOSED", 0)).toBe(false);
    expect(x.c.closeEpoch(9, "OWNER_CLOSED", RECEIVED_AT)).toBe(false);
    expect(x.c.epochReport(1)!.state).toBe("OPEN");
    // An unattributed frame makes every epoch report unclean.
    const ua = collector();
    ua.ack();
    expect(ua.c.epochReport(1)!.collectionClean).toBe(true);
    ua.c.acceptFrame(null as never);
    expect(ua.c.epochReport(1)!.collectionClean).toBe(false);
    // Dirty before acknowledgement stays dirty after it.
    const d = collector();
    d.frame(notif());
    d.ack();
    expect(d.c.epochReport(1)!.collectionClean).toBe(false);
  });

  it("N11: dropped metadata is explicit and independent of collection; envelopes are never dropped", () => {
    const h = collector({ maxRetainedFrameRecords: 2, maxRetainedNotifications: 1 });
    h.ack();
    const results = [1, 2, 3].map((n) => h.frame(notif({ sig: signatureOf(n) })));
    expect(results.map((r) => r.status)).toEqual([
      "ACCEPTED_NOTIFICATION",
      "ACCEPTED_NOTIFICATION",
      "ACCEPTED_NOTIFICATION",
    ]);
    expect(
      results.map((r) => (r.status === "ACCEPTED_NOTIFICATION" ? r.recordRetained : null)),
    ).toEqual([true, false, false]);
    const report = h.c.epochReport(1)!;
    expect(report.collectionClean).toBe(true); // collection is clean...
    expect(report.metadataRetention).toEqual({
      frameRecordsRetained: 2,
      frameRecordsDropped: 2,
      notificationRecordsRetained: 1,
      notificationRecordsDropped: 2,
      complete: false, // ...but the retained metadata is not complete
      rawPayloadRetained: false,
      replayableCaptureEstablished: false,
    });
    expect(h.c.counters().metadataRetention.complete).toBe(false);
    // Only notification records dropped: still incomplete.
    const n = collector({ maxRetainedNotifications: 1 });
    n.ack();
    n.frame(notif({ sig: signatureOf(1) }));
    n.frame(notif({ sig: signatureOf(2) }));
    expect(n.c.epochReport(1)!.metadataRetention).toMatchObject({
      frameRecordsDropped: 0,
      notificationRecordsDropped: 1,
      complete: false,
    });
    expect(n.c.counters().metadataRetention.complete).toBe(false);
    expect(h.c.notifications()).toHaveLength(1);
    expect(h.c.frameRecords()).toHaveLength(2);
    expectConserved(h.c, [1], 3);
    // Saturation helper.
    expect(cpmmCollectorSaturatingAdd(1, 2)).toEqual({ value: 3, saturated: false });
    expect(cpmmCollectorSaturatingAdd(Number.MAX_SAFE_INTEGER - 1, 2)).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      saturated: true,
    });
    // Snapshots are frozen and unchanged by later frames; input bytes are never kept.
    const snaps = [h.c.epochReport(1), h.c.counters(), h.c.notifications(), h.c.frameRecords()];
    const text = JSON.stringify(snaps);
    for (const s of snaps) expectPlainFrozen(s);
    const input = notif({ sig: signatureOf(7) });
    const r = h.frame(input);
    input.fill(0x41);
    h.frame(notif({ sig: signatureOf(8) }));
    expect(JSON.stringify(snaps)).toBe(text);
    if (r.status !== "ACCEPTED_NOTIFICATION") throw new Error(r.disposition);
    expect(r.notification.signature).toBe(signatureOf(7));
    expect(r.envelope.notification).toMatchObject({ signature: signatureOf(7) });
  });

  it("N12: credential-bearing frames leave no trace except length and hash", () => {
    const h = collector();
    h.ack();
    const frames = [
      notif({ logs: [`Program log: ${RPC_URL}`, SECRET_KEY] }),
      enc({ jsonrpc: "2.0", id: 99, error: { code: 1, message: SECRET_KEY } }),
      enc(`garbage ${SECRET_KEY}`),
      enc({ jsonrpc: "2.0", method: SECRET_KEY, params: {} }),
    ];
    const results = frames.map((f) => h.frame(f));
    const out = JSON.stringify([
      results,
      h.c.epochReport(1),
      h.c.counters(),
      h.c.notifications(),
      h.c.frameRecords(),
    ]).toLowerCase();
    for (const forbidden of ["k3ys3cr3", "api-key", "rpc.example.test", "program log"]) {
      expect(out).not.toContain(forbidden);
    }
    expect(results.map((r) => r.disposition)).toEqual([
      "NOTIFICATION_ACCEPTED",
      "MISMATCHED_RESPONSE_ID",
      "NOT_JSON",
      "UNEXPECTED_METHOD",
    ]);
  });

  it("N13a: handoff to the real ledger; duplicates stay visible; the conjunction is required", async () => {
    const h = ledgerHarness();
    h.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START });
    const col = collector();
    col.ack();
    const r = col.frame(notif({ sig: signatureOf(1) }), { at: RECEIVED_AT });
    if (r.status !== "ACCEPTED_NOTIFICATION") throw new Error(r.disposition);
    const rec = await h.account(r.envelope, rpcResult(txResult(signatureOf(1))));
    expect(rec).toMatchObject({ status: "RECORDED", record: { disposition: "INGESTED" } });
    expect(eligible(h, col.c)).toMatchObject({
      ledgerComplete: true,
      collectionClean: true,
      eligible: true,
    });
    // A repeated notification is a ledger duplicate in its receiving epoch, not a new request.
    const again = col.frame(notif({ sig: signatureOf(1) }), { at: RECEIVED_AT + 100 });
    if (again.status !== "ACCEPTED_NOTIFICATION") throw new Error(again.disposition);
    expect((await h.ledger.account(again.envelope)).status).toBe("DUPLICATE");
    expect(h.dispatches()).toBe(1);
    // A dirty collector epoch makes an otherwise complete ledger window ineligible.
    col.frame(notif({ sub: SUB + 1 }));
    expect(eligible(h, col.c)).toMatchObject({
      ledgerComplete: true,
      collectionClean: false,
      eligible: false,
    });
  });

  it("N13b (clarification 1): a failed-status claim is never eligible, whether retrieval agrees or contradicts", async () => {
    // Agreeing: the response is a failed transaction.
    const a = ledgerHarness();
    a.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START });
    const ca = collector();
    ca.ack();
    const fa = ca.frame(notif({ err: { InstructionError: [0, "x"] } }), { at: RECEIVED_AT });
    if (fa.status !== "ACCEPTED_NOTIFICATION") throw new Error(fa.disposition);
    const ra = await a.account(fa.envelope, rpcResult(txResult(signatureOf(1), true)));
    expect(ra).toMatchObject({
      record: {
        disposition: "POLICY_PENDING",
        policyPending: "FAILED_TRANSACTION_POLICY_UNREVIEWED",
      },
    });
    expect(eligible(a, ca.c)).toMatchObject({
      ledgerComplete: false,
      collectionClean: false,
      eligible: false,
    });
    // Contradictory: the response is a successful swap, so the ledger alone would be complete.
    const b = ledgerHarness();
    b.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START });
    const cb = collector();
    cb.ack();
    const fb = cb.frame(notif({ err: { InstructionError: [0, "x"] } }), { at: RECEIVED_AT });
    if (fb.status !== "ACCEPTED_NOTIFICATION") throw new Error(fb.disposition);
    const rb = await b.account(fb.envelope, rpcResult(txResult(signatureOf(1))));
    expect(rb).toMatchObject({ record: { disposition: "INGESTED" } });
    expect(eligible(b, cb.c)).toMatchObject({
      ledgerComplete: true,
      collectionClean: false,
      eligible: false,
    });
    expect(cb.c.epochReport(1)!.notificationsWithTransactionError).toBe(1);
  });

  it("N13c (clarification 2): a fake owner stops outstanding ledger work after abnormal collector closure", async () => {
    const h = ledgerHarness();
    h.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START });
    const col = collector();
    col.ack();
    // The owner's gate: refuse once the collector epoch closed abnormally; abort on cancellation.
    const abort = new AbortController();
    const gate: CpmmLifecycleGate = {
      signal: abort.signal,
      refusal: () => {
        const r = col.c.epochReport(1);
        return r && r.state === "CLOSED" && r.closeReason !== "OWNER_CLOSED"
          ? "COLLECTION_CLOSED_ABNORMALLY"
          : null;
      },
    };
    const f1 = col.frame(notif({ sig: signatureOf(1) }), { at: RECEIVED_AT });
    if (f1.status !== "ACCEPTED_NOTIFICATION") throw new Error(f1.disposition);
    const hold = held();
    const pending = h.account(f1.envelope, hold.responder, gate);
    await flush();
    expect(h.dispatches()).toBe(1);
    // Abnormal closure while the resolution is in flight: the response is refused, not ingested.
    col.c.closeEpoch(1, "TRANSPORT_CLOSED", RECEIVED_AT + 10);
    hold.result(txResult(signatureOf(1)));
    const r1 = await pending;
    expect(r1).toMatchObject({
      record: { disposition: "UNRESOLVED", blockingClass: "CANCELLED", factKind: "LATE_RESPONSE" },
    });
    expect(h.tracker.getEventsCount()).toBe(0);
    // Cancellation path: the owner aborts; the in-flight request is cancelled.
    const h2 = ledgerHarness();
    h2.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START });
    const col2 = collector();
    col2.ack();
    const abort2 = new AbortController();
    const f2 = col2.frame(notif({ sig: signatureOf(2) }), { at: RECEIVED_AT });
    if (f2.status !== "ACCEPTED_NOTIFICATION") throw new Error(f2.disposition);
    const hold2 = held();
    const p2 = h2.account(f2.envelope, hold2.responder, { signal: abort2.signal });
    await flush();
    col2.c.closeEpoch(1, "CANCELLED", RECEIVED_AT + 10);
    abort2.abort();
    expect(await p2).toMatchObject({
      record: { blockingClass: "CANCELLED", factKind: "CANCELLED_IN_FLIGHT" },
    });
    expect(abort.signal.aborted).toBe(false);
  });

  it("N14: conservation holds after every step of a mixed sequence across epochs", () => {
    const h = collector({ maxRetainedFrameRecords: 5, maxRetainedNotifications: 2 });
    let envelopes = 0;
    const step = (r: CpmmFrameResult) => {
      if (r.status === "ACCEPTED_NOTIFICATION") envelopes++;
      expectConserved(h.c, [1, 2], envelopes);
    };
    step(h.frame(notif()));
    step(h.ack());
    step(h.frame(notif({ sig: signatureOf(2) })));
    step(h.frame(notif({ sig: signatureOf(2) })));
    step(h.frame(enc("x")));
    step(h.c.acceptFrame(null as never));
    h.c.openEpoch({ epoch: 2, observationStartMs: OBS_START, subscribeRequestId: 11 });
    h.setEpoch(2);
    step(h.frame(notif(), { epoch: 1 }));
    step(h.frame(ackFrame(11)));
    step(h.frame(notif({ sig: signatureOf(3), err: "e" })));
    step(h.frame(notif(), { epoch: 5 }));
    expect(envelopes).toBe(3);
    expect(h.c.version).toBeGreaterThan(10);
  });

  it("N15: source boundaries (no transport, clock, timers, HTTP, session, adapter, ledger or tracker calls)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./CpmmPoolNotificationCollector.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /setTimeout|setInterval|setImmediate|queueMicrotask/,
      /Date\.now|performance\.now|new Date\(/,
      /AbortController/,
      /\.send\(|\.close\(|\.ping\(|\.on\(|WebSocket/,
      /PaperRequestSession|\.dispatch\(|\.resolve\(|\.ingest\(|\.account\(/,
      /ingestTrade|recordCollectionGap|recordHeartbeat|recordCompletedRange/,
      /blockTime/,
      /process\.env/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "../research/pilot/RaydiumAmmParser.js",
      "./ExactPoolHistoryEnumerator.js",
      "./CpmmResolutionAccountingLedger.js",
      "./RaydiumCpmmTransactionSourceAdapter.js",
      "./RaydiumCpmmSwapDecoder.js",
    ]);
    expect(src).toMatch(/import type \{ CpmmNotificationEnvelope \}/);
    expect(src).toMatch(/import type \{ CpmmAdapterBinding \}/);
  });

  // --- review regressions (after b06108c) ----------------------------------------------------------

  const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const decodeSpies = () => {
    const parse = vi.spyOn(JSON, "parse");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const p0 = parse.mock.calls.length;
    const d0 = decode.mock.calls.length;
    return () => [parse.mock.calls.length - p0, decode.mock.calls.length - d0];
  };

  it("N16a (review 1): a shadowed byteLength never hides a genuine view's actual length", () => {
    const decoded = decodeSpies();
    const h = collector({ maxFrameBytes: 8 });
    const bytes = ackFrame();
    expect(bytes.byteLength).toBe(38);
    Object.defineProperty(bytes, "byteLength", { value: 1 });
    expect(bytes.byteLength).toBe(1);
    const r = h.c.acceptFrame({ epoch: 1, bytes, receivedAtMs: OBS_START + 10 });
    expect(disp(r)).toEqual(["OVERSIZE_FRAME", true, null]);
    // Not copied, hashed or decoded; the genuine length is counted.
    expect(decoded()).toEqual([0, 0]);
    expect(h.c.frameRecords().at(-1)).toMatchObject({
      byteLength: 38,
      sha256: null,
      receivedAtMs: null,
    });
    expect(h.c.epochReport(1)).toMatchObject({
      subscription: "AWAITING_ACK",
      frames: 1,
      bytes: 38,
      acquisitionLimitLatched: true,
      collectionClean: false,
    });
    expect(h.c.counters().bytes).toBe(38);
    // Under a generous limit the frame is accepted, but counted at its genuine length; shadowed
    // offset, buffer, length and iterator are ignored and only the genuine range is read.
    const g = collector();
    const ack = ackFrame();
    const backing = new Uint8Array(ack.byteLength + 10).fill(0xff);
    backing.set(ack, 5);
    const view = backing.subarray(5, 5 + ack.byteLength);
    let iterated = 0;
    for (const [k, value] of [
      ["byteLength", 1],
      ["byteOffset", 0],
      ["length", 1],
      ["buffer", new ArrayBuffer(1)],
      [
        Symbol.iterator,
        () => {
          iterated++;
          return [0x7b][Symbol.iterator]();
        },
      ],
    ] as const) {
      Object.defineProperty(view, k, { value });
    }
    expect(disp(g.frame(view))).toEqual(["SUBSCRIBE_ACKNOWLEDGED", false, null]);
    expect(iterated).toBe(0);
    expect(g.c.frameRecords().at(-1)).toMatchObject({
      byteLength: ack.byteLength,
      sha256: sha256Hex(ack),
    });
    expect(g.c.epochReport(1)).toMatchObject({ bytes: ack.byteLength, collectionClean: true });
    expect(g.c.counters().bytes).toBe(ack.byteLength);
    expectConserved(g.c, [1]);
  });

  it("N16b (review 1): a proxy is rejected before any trap or iterator runs", () => {
    const decoded = decodeSpies();
    const ack = ackFrame();
    let traps = 0;
    let iterated = 0;
    const proxy = new Proxy(ack, {
      get(t, k) {
        traps++;
        if (k === "byteLength") return 1;
        if (k === Symbol.iterator) {
          return () => {
            iterated++;
            return t[Symbol.iterator]();
          };
        }
        return Reflect.get(t, k) as unknown;
      },
      getPrototypeOf(t) {
        traps++;
        return Reflect.getPrototypeOf(t);
      },
      getOwnPropertyDescriptor(t, k) {
        traps++;
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    for (const max of [8, 4_096]) {
      const h = collector({ maxFrameBytes: max });
      const r = h.c.acceptFrame({ epoch: 1, bytes: proxy, receivedAtMs: OBS_START + 10 });
      expect(disp(r)).toEqual(["FRAME_INVALID", true, "FRAME_ENVELOPE"]);
      expect(r.epoch).toBeNull();
      expect(h.c.epochReport(1)).toMatchObject({
        subscription: "AWAITING_ACK",
        frames: 0,
        bytes: 0,
        collectionClean: false,
      });
      expect(h.c.counters()).toMatchObject({ frames: 1, bytes: 0, unattributedFrames: 1 });
      expect(h.c.frameRecords().at(-1)).toMatchObject({ byteLength: 0, sha256: null });
    }
    expect([traps, iterated]).toEqual([0, 0]);
    expect(decoded()).toEqual([0, 0]);
    // Other non-Uint8Array views stay refused.
    const r = collector();
    for (const bytes of [
      new Uint8ClampedArray(ack),
      new Int8Array(ack),
      new DataView(ack.buffer),
      Object.create(Uint8Array.prototype) as unknown,
    ]) {
      expect(r.frame(bytes as Uint8Array).disposition).toBe("FRAME_INVALID");
    }
  });

  it("N16c (review 1): Buffer, offset and length-tracking views are read over exactly their validated range", () => {
    const ack = ackFrame();
    const note = notif();
    const h = collector();
    // A pooled Buffer (non-zero offset into a shared allocation).
    const buf = Buffer.from(ack);
    expect(disp(h.frame(buf))).toEqual(["SUBSCRIBE_ACKNOWLEDGED", false, null]);
    // A length-tracking view at a non-zero offset into a resizable buffer.
    const Resizable = ArrayBuffer as unknown as new (
      n: number,
      o: { maxByteLength: number },
    ) => ArrayBuffer & { resize(n: number): void };
    const rab = new Resizable(note.byteLength + 3, { maxByteLength: 4_096 });
    const tracking = new Uint8Array(rab, 3);
    tracking.set(note);
    new Uint8Array(rab, 0, 3).fill(0xff);
    const r = h.frame(tracking);
    expect(r.disposition).toBe("NOTIFICATION_ACCEPTED");
    expect(h.c.frameRecords().at(-1)).toMatchObject({
      byteLength: note.byteLength,
      sha256: sha256Hex(note),
    });
    // Growing the buffer afterwards changes nothing already recorded.
    rab.resize(note.byteLength + 3 + 64);
    expect(tracking.byteLength).toBe(note.byteLength + 64);
    expect(h.c.frameRecords().at(-1)!.byteLength).toBe(note.byteLength);
    expect(h.c.epochReport(1)).toMatchObject({
      bytes: ack.byteLength + note.byteLength,
      collectionClean: true,
    });
    // Its grown length is now what is validated: trailing zero bytes are not JSON.
    expect(h.frame(tracking).disposition).toBe("NOT_JSON");
    expect(h.c.frameRecords().at(-1)!.byteLength).toBe(note.byteLength + 64);
    expectConserved(h.c, [1]);
  });

  it("N17 (review 2): close times before observation start or the latest valid receipt are refused", () => {
    // Acknowledgement at OBS_START + 10, notification at OBS_START + 20.
    const dirtyAfter = (h: ReturnType<typeof collector>) => {
      h.ack();
      expect(h.frame(notif()).disposition).toBe("NOTIFICATION_ACCEPTED");
    };
    for (const at of [OBS_START - 1, OBS_START, OBS_START + 15, OBS_START + 19]) {
      for (const reason of ["OWNER_CLOSED", "TRANSPORT_CLOSED"] as const) {
        const h = collector();
        dirtyAfter(h);
        const before = h.c.epochReport(1);
        const v = h.c.version;
        expect(h.c.closeEpoch(1, reason, at), `${reason} ${at}`).toBe(false);
        expect(h.c.version).toBe(v);
        expect(h.c.epochReport(1)).toEqual(before);
        expect(before).toMatchObject({ state: "OPEN", closedAtMs: null, collectionClean: true });
        // Still open: the next frame is attributed normally.
        expect(h.frame(notif({ sig: signatureOf(2) })).disposition).toBe("NOTIFICATION_ACCEPTED");
      }
    }
    // Equality with the latest valid receipt is accepted.
    const e = collector();
    dirtyAfter(e);
    expect(e.c.closeEpoch(1, "OWNER_CLOSED", OBS_START + 20)).toBe(true);
    expect(e.c.epochReport(1)).toMatchObject({
      state: "CLOSED",
      closedAtMs: OBS_START + 20,
      closeReason: "OWNER_CLOSED",
      collectionClean: true,
    });
    // With no frames, equality with observation start is accepted and earlier is refused.
    const s = collector();
    expect(s.c.closeEpoch(1, "CANCELLED", OBS_START - 1)).toBe(false);
    expect(s.c.closeEpoch(1, "CANCELLED", OBS_START)).toBe(true);
    expect(s.c.epochReport(1)).toMatchObject({ closedAtMs: OBS_START, closeReason: "CANCELLED" });
    // A receipt-valid but undecodable frame still advances the latest receipt.
    const m = collector();
    m.ack();
    m.frame(enc("not json"), { at: OBS_START + 30 });
    expect(m.c.closeEpoch(1, "OWNER_CLOSED", OBS_START + 29)).toBe(false);
    expect(m.c.closeEpoch(1, "OWNER_CLOSED", OBS_START + 30)).toBe(true);
  });

  it("N17b (review 2): supersession never fabricates a close time earlier than known receipts", () => {
    const superseded = (start: number, frames = true) => {
      const h = collector();
      if (frames) {
        h.ack();
        h.frame(notif());
      }
      expect(
        h.c.openEpoch({ epoch: 2, observationStartMs: start, subscribeRequestId: 11 }).status,
      ).toBe("OPENED");
      return h.c.epochReport(1);
    };
    for (const start of [OBS_START + 15, OBS_START + 19, OBS_START - 1, OBS_START]) {
      expect(superseded(start), String(start)).toMatchObject({
        state: "CLOSED",
        closeReason: "SUPERSEDED",
        closedAtMs: null,
        collectionClean: false,
      });
    }
    expect(superseded(OBS_START + 20)!.closedAtMs).toBe(OBS_START + 20);
    expect(superseded(OBS_START + 99)!.closedAtMs).toBe(OBS_START + 99);
    // Without frames: before the epoch's own observation start is unknown; equality is kept.
    expect(superseded(OBS_START - 1, false)!.closedAtMs).toBeNull();
    expect(superseded(OBS_START, false)!.closedAtMs).toBe(OBS_START);
    // A refused but valid open closes with a truthful instant too; an invalid one with null.
    const r = collector();
    r.ack();
    r.frame(notif());
    expect(
      r.c.openEpoch({ epoch: 0, observationStartMs: OBS_START + 5, subscribeRequestId: 11 }),
    ).toEqual({ status: "REFUSED", code: "EPOCH_NOT_INCREASING" });
    expect(r.c.epochReport(1)).toMatchObject({ closeReason: "SUPERSEDED", closedAtMs: null });
    const i = collector();
    expect(i.c.openEpoch({ epoch: 2 } as never).status).toBe("REFUSED");
    expect(i.c.epochReport(1)).toMatchObject({ closeReason: "SUPERSEDED", closedAtMs: null });
  });

  it("N18 (review 3): building an unsubscribe is not sending it; clean only after a first valid acknowledgement", () => {
    const h = collector();
    expect(h.c.epochReport(1)).toMatchObject({
      subscription: "AWAITING_ACK",
      collectionClean: false,
      unsubscribe: { status: "NOT_BUILT", requestId: null },
    });
    h.ack();
    expect(h.c.epochReport(1)).toMatchObject({
      subscription: "ACKNOWLEDGED",
      collectionClean: true,
    });
    const frames = h.c.counters().frames;
    expect(h.c.unsubscribeFrame(1, 8)).not.toBeNull();
    // Only prepared: nothing observed, nothing counted, cleanliness unchanged.
    expect(h.c.epochReport(1)).toMatchObject({
      unsubscribe: { status: "BUILT_UNOBSERVED", requestId: 8 },
      collectionClean: true,
    });
    expect(h.c.counters().frames).toBe(frames);
    // The independently observed acknowledgement is kept; a contradicting duplicate never changes it.
    expect(h.frame(enc({ jsonrpc: "2.0", id: 8, result: true })).disposition).toBe(
      "UNSUBSCRIBE_ACKNOWLEDGED",
    );
    expect(disp(h.frame(enc({ jsonrpc: "2.0", id: 8, result: false })))).toEqual([
      "DUPLICATE_RESPONSE",
      true,
      "UNSUBSCRIBE",
    ]);
    expect(h.c.epochReport(1)).toMatchObject({
      unsubscribe: { status: "ACKNOWLEDGED", requestId: 8 },
      collectionClean: false,
    });
    // Sticky uncertainty is never cleared: a valid acknowledgement after a dirty frame stays dirty.
    const d = collector();
    d.frame(enc("not json"));
    expect(d.ack().disposition).toBe("SUBSCRIBE_ACKNOWLEDGED");
    expect(d.c.epochReport(1)!.collectionClean).toBe(false);
  });

  it("N19 (item 15): getBinding() is a read-only frozen copy, available before any epoch", () => {
    const { c } = collector({}, false);
    const v = c.version;
    const a = c.getBinding();
    expect(a).toEqual(BINDING);
    expect(Object.keys(a)).toEqual(["poolAddress", "candidateMint"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).not.toBe(c.getBinding());
    expect(() => {
      (a as { poolAddress: string }).poolAddress = "x";
    }).toThrow();
    expect(c.getBinding()).toEqual(BINDING);
    expect(c.version).toBe(v);
    expect(c.epochReport(1)).toBeNull();
  });
});
