/**
 * CPMM resolution accounting ledger: synthetic offline tests (assessment §8.38.17 item 13).
 *
 * Harness: the item 12 pattern. A real PaperRequestSession with a virtual clock and timers, a
 * scripted in-memory fetch (no network), a real evidence recorder, a real adapter on the Stage 1
 * fixture pool, and a real tracker. Transactions are local literal `getTransaction` results.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import {
  CPMM_INVALID_CODES,
  CpmmResolutionAccountingLedger,
  cpmmSaturatingIncrement,
  type CpmmAccountResult,
  type CpmmAccountingWindow,
  type CpmmLedgerLimits,
  type CpmmSignatureAccountingRecord,
  type CpmmWindowAccountingSummary,
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
  type CpmmResolutionFact,
  type CpmmTransactionSourceOptions,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";

type Loose = ReturnType<typeof JSON.parse>;

// ---------------------------------------------------------------------------------------------
// Literal fixtures
// ---------------------------------------------------------------------------------------------

const SECRET_KEY = "k3yS3cr3tAbCdEfGh1234";
const RPC_URL = `https://rpc.example.test/?api-key=${SECRET_KEY}`;
const SECRETS = [RPC_URL, SECRET_KEY];

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
const TWO_SWAPS = () => [swapIx("BUY"), swapIx("SELL", 2_500_000n, 900_000_000n)];

const SLOT = 312_000_000;
const BLOCK_TIME = 1_794_829_420;
const BT_MS = BLOCK_TIME * 1000;
const RECEIVED_AT = 1_794_829_421_500;
const OBS_START = 1_794_829_400_000;
const TRACKER_NOW = 1_794_829_422_000;

function txResult(
  sig: string,
  top: Ix[],
  o: { slot?: number; blockTime?: number | null; extraLogs?: string[] } = {},
): Loose {
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
  logs.push(...(o.extraLogs ?? []));
  return {
    slot: o.slot ?? SLOT,
    blockTime: o.blockTime === undefined ? BLOCK_TIME : o.blockTime,
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

interface NoticeOpts {
  slot?: number;
  blockTime?: number | null;
  receivedAtMs?: number;
  omitBlockTime?: boolean;
}
const notice = (n: number, o: NoticeOpts = {}) => ({
  signature: signatureOf(n),
  slot: o.slot ?? SLOT,
  receivedAtMs: o.receivedAtMs ?? RECEIVED_AT,
  ...(o.omitBlockTime ? {} : { blockTime: o.blockTime === undefined ? BLOCK_TIME : o.blockTime }),
});
const env = (n: ReturnType<typeof notice>, epoch = 1) => ({
  notification: n,
  epoch,
  hostReceivedAtMs: n.receivedAtMs,
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

type Responder = (req: { id: number; body: string; signal: AbortSignal }) => Promise<Response>;
const reply =
  (make: (id: number) => string, status = 200): Responder =>
  async ({ id }) =>
    new Response(make(id), { status });
const rpcResult = (result: unknown) =>
  reply((id) => JSON.stringify({ jsonrpc: "2.0", id, result }));
const okSwap = (n: number, top: Ix[] = [swapIx("BUY")], o: Parameters<typeof txResult>[2] = {}) =>
  rpcResult(txResult(signatureOf(n), top, o));
const noTarget = (n: number, o: Parameters<typeof txResult>[2] = {}) =>
  rpcResult(txResult(signatureOf(n), [memoIx()], o));
const failedTx = (n: number, o: Parameters<typeof txResult>[2] = {}) => {
  const t = txResult(signatureOf(n), [swapIx("BUY")], o);
  t.meta.err = { InstructionError: [0, { Custom: 6005 }] };
  return rpcResult(t);
};
const networkError = (): Responder => async () => {
  throw new TypeError("fetch failed");
};

/** A response held until the test releases it. */
function held() {
  let id = 0;
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const responder: Responder = (req) =>
    new Promise<Response>((res, rej) => {
      id = req.id;
      resolve = res;
      reject = rej;
      req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  return {
    responder,
    result: (result: unknown) =>
      resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 })),
    fail: () => reject(new TypeError("fetch failed")),
  };
}

/** A real adapter whose resolve() can be observed or replaced (instanceof still holds). */
class HookedAdapter extends RaydiumCpmmTransactionSourceAdapter {
  public after: ((fact: CpmmResolutionFact) => CpmmResolutionFact | void) | null = null;
  public replace: ((n: unknown) => Promise<CpmmResolutionFact>) | null = null;
  public resolveCalls = 0;
  public override async resolve(n: unknown, gate?: CpmmLifecycleGate): Promise<CpmmResolutionFact> {
    this.resolveCalls++;
    if (this.replace) return this.replace(n);
    const f = await super.resolve(n, gate);
    return (this.after?.(f) ?? f) as CpmmResolutionFact;
  }
}

interface HarnessOptions {
  maxTracked?: number;
  open?: boolean;
  limits?: Partial<CpmmLedgerLimits>;
  noEpoch?: boolean;
}

const LIMITS: CpmmLedgerLimits = {
  maxSignatureRecords: 16,
  maxDuplicateDetailsPerRecord: 4,
  maxEpochs: 4,
};

const newTracker = (poolId = POOL.poolAddress, tokenMint = POOL.candidateMint) =>
  new RollingTradeFlowTracker({
    poolId,
    tokenMint,
    trackingStartedMs: OBS_START,
    clock: () => TRACKER_NOW,
  });

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
  const calls: string[] = [];
  const script: Responder[] = [];
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    calls.push(String(init.body));
    const r = script.shift();
    if (!r) throw new Error("UNSCRIPTED_REQUEST");
    return r({
      id: JSON.parse(String(init.body)).id,
      body: String(init.body),
      signal: init.signal as AbortSignal,
    });
  }) as unknown as typeof fetch;
  const recorder = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 8 });
  const tap = { fn: (e: PaperRequestExchangeEvidence) => recorder.observe(e) };
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
    maxResponseBytes: 100_000,
    maxSupportedTransactionVersion: 0,
  };
  const adapter = new HookedAdapter(options);
  const tracker = newTracker();
  const ledger = new CpmmResolutionAccountingLedger({
    binding: { poolAddress: POOL.poolAddress, candidateMint: POOL.candidateMint },
    adapter,
    tracker,
    limits: { ...LIMITS, ...o.limits },
  });
  if (!o.noEpoch) {
    expect(ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START })).toEqual({
      status: "OPENED",
      epoch: 1,
    });
  }
  return {
    state,
    session,
    recorder,
    adapter,
    options,
    tracker,
    ledger,
    calls,
    script,
    tap,
    timers,
    advance(ms: number) {
      state.now += ms;
      fireDue();
    },
    dispatches: () => session.getStatus().ledger.length,
    /** One account() after spacing past the previous dispatch. */
    account(e: unknown, responder?: Responder, gate?: CpmmLifecycleGate) {
      state.now += 2_500;
      if (responder) script.push(responder);
      return ledger.account(e as never, gate);
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

function expectPlainFrozen(v: unknown, path = "value"): void {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
  expect(typeof v, path).toBe("object");
  expect(Object.isFrozen(v), path).toBe(true);
  for (const [k, x] of Object.entries(v as object)) expectPlainFrozen(x, `${path}.${k}`);
}

const recorded = (r: CpmmAccountResult): CpmmSignatureAccountingRecord => {
  if (r.status !== "RECORDED") throw new Error(`expected RECORDED, got ${r.status}`);
  return r.record;
};

const WINDOW: CpmmAccountingWindow = {
  epoch: 1,
  windowStartMs: BT_MS - 30_000,
  windowEndMs: BT_MS + 30_000,
  cutoff: { slot: SLOT + 100, blockTimeMs: BT_MS + 60_000, provenance: "ON_CHAIN_BLOCK_TIME" },
  receiptFrontierMs: RECEIVED_AT + 1_000,
};
const win = (over: Partial<CpmmAccountingWindow> = {}): CpmmAccountingWindow => ({
  ...WINDOW,
  ...over,
});
function summary(
  h: ReturnType<typeof harness>,
  w: CpmmAccountingWindow = WINDOW,
): CpmmWindowAccountingSummary {
  const r = h.ledger.summarize(w);
  if (r.status !== "SUMMARY") throw new Error(`summary refused: ${r.code}`);
  return r.summary;
}

/** Every item F conservation equation. */
function expectConserved(h: ReturnType<typeof harness>): void {
  const c = h.ledger.counters();
  const eps = h.ledger.epochs();
  const recs = h.ledger.records();
  let sumEpoch = 0;
  for (const e of eps) {
    const invalid = CPMM_INVALID_CODES.reduce((s, k) => s + e.invalid[k], 0);
    expect(e.occurrences, `epoch ${e.epoch}`).toBe(
      e.firstOccurrences +
        e.duplicates.sameEpoch +
        e.duplicates.crossEpoch +
        invalid +
        e.capacityRefused,
    );
    expect(recs.filter((r) => r.epoch === e.epoch)).toHaveLength(e.firstOccurrences);
    sumEpoch += e.occurrences;
  }
  expect(c.occurrences).toBe(sumEpoch + c.unattributedOccurrences);
  expect(recs.length).toBeLessThanOrEqual(LIMITS.maxSignatureRecords * 4);
  expect(recs.reduce((s, r) => s + r.duplicateOccurrences, 0)).toBe(
    eps.reduce((s, e) => s + e.duplicates.sameEpoch + e.duplicates.crossEpoch, 0),
  );
  for (const r of recs) {
    expect(r.duplicateDetails.length + r.duplicateDetailsDropped).toBe(r.duplicateOccurrences);
    const g = r.ingestion;
    expect(g.accepted + g.rejected + g.unattempted + g.indeterminate).toBe(g.total);
  }
  expect(new Set(recs.map((r) => r.signature)).size).toBe(recs.length);
  expect(recs.map((r) => r.sequence)).toEqual(recs.map((_, i) => i + 1));
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM resolution accounting ledger (synthetic, offline)", () => {
  it("L1a: adapter outcomes map to their dispositions and classes (real adapter)", async () => {
    const h = harness({ limits: { maxSignatureRecords: 32 } });
    const cls = async (n: number, responder: Responder, o: NoticeOpts = {}) => {
      const r = recorded(await h.account(env(notice(n, o)), responder));
      return [r.disposition, r.blockingClass, r.policyPending, r.factKind];
    };
    expect(await cls(1, okSwap(1))).toEqual(["INGESTED", null, null, "RESOLVED_SWAPS"]);
    expect(await cls(2, noTarget(2))).toEqual([
      "POLICY_PENDING",
      null,
      "NO_TARGET_SWAP_POLICY_UNREVIEWED",
      "RESOLVED_NO_TARGET_SWAP",
    ]);
    expect(await cls(3, failedTx(3))).toEqual([
      "POLICY_PENDING",
      null,
      "FAILED_TRANSACTION_POLICY_UNREVIEWED",
      "RECORDED_FAILED_TRANSACTION",
    ]);
    expect(await cls(4, rpcResult(null))).toEqual([
      "UNRESOLVED",
      "TRANSACTION_UNAVAILABLE",
      null,
      "TRANSACTION_NOT_FOUND",
    ]);
    const rpcErr = reply((id) =>
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "x" } }),
    );
    expect((await cls(5, rpcErr))[1]).toBe("TRANSACTION_UNAVAILABLE");
    expect(
      (
        await cls(
          6,
          reply(() => "{}", 500),
        )
      )[1],
    ).toBe("TRANSACTION_UNAVAILABLE");
    expect((await cls(7, networkError()))[1]).toBe("TRANSACTION_UNAVAILABLE");
    expect(
      (
        await cls(
          8,
          reply(() => "not json"),
        )
      )[1],
    ).toBe("RESPONSE_CONTRADICTED");
    expect((await cls(9, okSwap(99)))[1]).toBe("RESPONSE_CONTRADICTED");
    expect((await cls(10, okSwap(10, [swapIx("BUY")], { slot: SLOT + 1 })))[1]).toBe(
      "RESPONSE_CONTRADICTED",
    );
    const v9 = txResult(signatureOf(11), [swapIx("BUY")]);
    v9.version = "v9";
    expect(await cls(11, rpcResult(v9))).toEqual([
      "UNRESOLVED",
      "DECODER_UNRESOLVED",
      null,
      "UNRESOLVED",
    ]);
    const secretLog = txResult(signatureOf(12), [swapIx("BUY")], {
      extraLogs: [`Program log: ${SECRET_KEY}`],
    });
    expect((await cls(12, rpcResult(secretLog)))[1]).toBe("EVIDENCE_WITHHELD");
    const saved = h.tap.fn;
    h.tap.fn = () => undefined;
    expect((await cls(13, okSwap(13)))[1]).toBe("EVIDENCE_UNVERIFIED");
    h.tap.fn = saved;
    const aborted = new AbortController();
    aborted.abort();
    const r14 = recorded(await h.account(env(notice(14)), undefined, { signal: aborted.signal }));
    expect([r14.blockingClass, r14.factCode]).toEqual(["CANCELLED", "CALLER_CANCELLED"]);
    const r15 = recorded(await h.account(env(notice(15)), undefined, { refusal: () => "NO" }));
    expect([r15.blockingClass, r15.factCode]).toEqual(["CANCELLED", "CALLER_REFUSAL"]);
    // The adapter reserved a signature the ledger never saw.
    h.script.push(okSwap(16));
    h.state.now += 2_500;
    await h.adapter.resolve(notice(16));
    expect((await cls(16, okSwap(16)))[1]).toBe("DUPLICATE_WITHOUT_ORIGINAL");
    h.session.stop();
    expect((await cls(17, okSwap(17)))[1]).toBe("SESSION_ENDED");
    for (const r of h.ledger.records()) expectPlainFrozen(r);
    expect(h.ledger.records().map((r) => r.disposition)).not.toContain("PENDING");
    expectConserved(h);
  });

  it("L1b: refusals, capacity, validation disagreement, binding conflict, exceptions and unknown outcomes", async () => {
    const closed = harness({ open: false });
    const r = recorded(await closed.account(env(notice(1))));
    expect([r.blockingClass, r.factCode]).toEqual(["REQUEST_REFUSED", "REQUEST_SESSION_NOT_OPEN"]);
    const cap = harness({ maxTracked: 1 });
    expect(recorded(await cap.account(env(notice(1)), okSwap(1))).disposition).toBe("INGESTED");
    const c2 = recorded(await cap.account(env(notice(2))));
    expect(c2.blockingClass).toBe("ADAPTER_CAPACITY_REFUSED");
    expect(cap.dispatches()).toBe(1);

    const h = harness();
    const fake = (f: Partial<CpmmResolutionFact>, n = 1) =>
      ({
        kind: "RESOLVED_SWAPS",
        code: null,
        detail: null,
        notification: notice(n),
        exchange: null,
        postAwaitCheck: null,
        rpcErrorCode: null,
        decoder: null,
        events: [],
        replay: "NOT_DECODED",
        ingestible: false,
        ...f,
      }) as CpmmResolutionFact;
    const cases: [Partial<CpmmResolutionFact> | "THROW", string][] = [
      [{ kind: "INVALID_NOTIFICATION", notification: null }, "VALIDATION_DISAGREEMENT"],
      [{ kind: "INVALID_GATE" }, "VALIDATION_DISAGREEMENT"],
      [{ kind: "BRAND_NEW_KIND" as never }, "UNRECOGNIZED_OUTCOME"],
      [{ kind: "REQUEST_REFUSED", code: "SOMETHING_NEW" }, "UNRECOGNIZED_OUTCOME"],
      [{ kind: "LATE_RESPONSE", code: "SOMETHING_NEW" }, "UNRECOGNIZED_OUTCOME"],
      [{ kind: "TRANSACTION_NOT_FOUND", notification: notice(77) }, "BINDING_CONFLICT"],
      [
        { kind: "TRANSACTION_NOT_FOUND", notification: notice(1, { slot: SLOT + 1 }) },
        "BINDING_CONFLICT",
      ],
      [{ kind: "RESOLVED_SWAPS" }, "BINDING_CONFLICT"], // no events, not decoded
      ["THROW", "ACCOUNTING_EXCEPTION"],
    ];
    let n = 1;
    for (const [f, expected] of cases) {
      const sig = n++;
      h.adapter.replace =
        f === "THROW"
          ? async () => {
              throw new Error("boom");
            }
          : async () =>
              fake(
                { ...f, ...(f.notification === undefined ? { notification: notice(sig) } : {}) },
                sig,
              );
      const rec = recorded(await h.ledger.account(env(notice(sig))));
      expect(rec.disposition, expected).toBe("UNRESOLVED");
      expect(rec.blockingClass, expected).toBe(expected);
      expect(rec.verifiedSlot).toBeNull();
    }
    // Decoded kinds are verified only when every decoded precondition holds; each one alone fails.
    const decodedOk: Partial<CpmmResolutionFact> = {
      kind: "RESOLVED_NO_TARGET_SWAP",
      replay: "DECODER_REPLAYABLE",
      decoder: { status: "NO_MATCHING_SWAPS", reason: null, detail: null },
      exchange: { evidence: "VERIFIED" } as CpmmResolutionFact["exchange"],
      postAwaitCheck: { passed: true } as CpmmResolutionFact["postAwaitCheck"],
    };
    const variants: [Partial<CpmmResolutionFact>, number | null][] = [
      [{}, SLOT],
      [{ replay: "NOT_DECODED" }, null],
      [{ decoder: null }, null],
      [{ exchange: { evidence: "MISSING" } as CpmmResolutionFact["exchange"] }, null],
      [{ exchange: null }, null],
      [{ postAwaitCheck: { passed: false } as CpmmResolutionFact["postAwaitCheck"] }, null],
      [{ postAwaitCheck: null }, null],
    ];
    let vs = 50;
    for (const [over, slot] of variants) {
      const sig = vs++;
      h.adapter.replace = async () =>
        fake({ ...decodedOk, ...over, notification: notice(sig) }, sig);
      const rec = recorded(await h.ledger.account(env(notice(sig))));
      expect(rec.disposition).toBe("POLICY_PENDING");
      expect([rec.verifiedSlot, rec.verifiedBlockTimeSec], JSON.stringify(over)).toEqual(
        slot === null ? [null, null] : [SLOT, BLOCK_TIME],
      );
    }
    expect(h.dispatches()).toBe(0);
    expect(h.tracker.getEventsCount()).toBe(0);
    expectConserved(h);
  });

  it("L2: only COMPLETE ingestion of bound replayable swaps is INGESTED; partial counts are exact and final", async () => {
    const h = harness();
    const one = recorded(await h.account(env(notice(1)), okSwap(1)));
    expect(one).toMatchObject({
      disposition: "INGESTED",
      verifiedSlot: SLOT,
      verifiedBlockTimeSec: BLOCK_TIME,
      ingestion: { status: "COMPLETE", total: 1, accepted: 1, rejected: 0, unattempted: 0 },
    });
    // PARTIAL: the first of two events is already in the tracker.
    let genuine: CpmmResolutionFact | null = null;
    h.adapter.after = (f) => {
      genuine = f;
    };
    const pre = harness();
    pre.script.push(okSwap(2, TWO_SWAPS()));
    pre.state.now += 2_500;
    const preFact = await pre.adapter.resolve(notice(2));
    expect(h.tracker.ingestTrade(preFact.events[0]!).ok).toBe(true);
    const partial = recorded(await h.account(env(notice(2)), okSwap(2, TWO_SWAPS())));
    expect(partial).toMatchObject({
      disposition: "INGESTION_INCOMPLETE",
      blockingClass: "INGEST_REJECTED",
      ingestion: { status: "PARTIAL", total: 2, accepted: 1, rejected: 1, unattempted: 0 },
    });
    expect(genuine).not.toBeNull();
    // NONE_ACCEPTED: both events already present.
    pre.script.push(okSwap(3, TWO_SWAPS()));
    pre.state.now += 2_500;
    const pre3 = await pre.adapter.resolve(notice(3));
    for (const e of pre3.events) h.tracker.ingestTrade(e);
    const none = recorded(await h.account(env(notice(3)), okSwap(3, TWO_SWAPS())));
    expect(none).toMatchObject({
      blockingClass: "INGEST_REJECTED",
      ingestion: { status: "NONE_ACCEPTED", total: 2, accepted: 0, rejected: 2 },
    });
    // A later notification of the partial signature is a duplicate and changes nothing.
    const before = h.dispatches();
    const dup = await h.account(env(notice(2)));
    expect(dup.status).toBe("DUPLICATE");
    expect(h.dispatches()).toBe(before);
    expect(h.ledger.records()[1]).toMatchObject({
      disposition: "INGESTION_INCOMPLETE",
      ingestion: { accepted: 1, rejected: 1 },
    });
    // A foreign copy of a genuine fact is never INGESTED.
    h.adapter.after = (f) => ({ ...f }) as CpmmResolutionFact;
    const foreign = recorded(await h.account(env(notice(4)), okSwap(4)));
    expect(foreign).toMatchObject({
      disposition: "UNRESOLVED",
      blockingClass: "BINDING_CONFLICT",
      ingestion: { status: "NOT_INGESTIBLE", total: 1, accepted: 0, unattempted: 1 },
    });
    expect(h.tracker.getEventsCount()).toBe(1 + 2 + 2);
    expectConserved(h);
  });

  it("L3: duplicates make no adapter call; a concurrent duplicate returns at once against PENDING", async () => {
    const h = harness();
    const hold = held();
    const v0 = h.ledger.version;
    const first = h.account(env(notice(1)), hold.responder);
    expect(h.ledger.version).toBe(v0 + 1); // the occurrence increment covers PENDING creation
    expect(h.ledger.records()[0]!.disposition).toBe("PENDING");
    await flush();
    const dup = await h.ledger.account(env(notice(1, { receivedAtMs: RECEIVED_AT + 10 })));
    expect(dup).toMatchObject({
      status: "DUPLICATE",
      firstSequence: 1,
      detailRetained: true,
      detail: { agreement: "AGREES", firstDispositionAtReceipt: "PENDING", epoch: 1 },
    });
    expect(h.ledger.version).toBe(v0 + 2);
    expect(h.adapter.resolveCalls).toBe(1);
    // While PENDING, the window is blocked and the record's position is unknown.
    expect(summary(h)).toMatchObject({ accountingComplete: false, positionUnknown: 1 });
    hold.result(txResult(signatureOf(1), [swapIx("BUY")]));
    const settled = recorded(await first);
    expect(settled.disposition).toBe("INGESTED");
    expect(settled.duplicateOccurrences).toBe(1);
    expect(h.ledger.version).toBe(v0 + 3); // one PENDING-to-terminal transition
    const v1 = h.ledger.version;
    expect((await h.ledger.account(env(notice(1)))).status).toBe("DUPLICATE");
    expect(h.ledger.version).toBe(v1 + 1);
    expect(h.adapter.resolveCalls).toBe(1);
    expect(h.dispatches()).toBe(1);
    expect(summary(h).accountingComplete).toBe(true);
    // A duplicate of a failed record changes nothing.
    const failed = recorded(await h.account(env(notice(2)), rpcResult(null)));
    await h.ledger.account(env(notice(2)));
    expect(h.ledger.records()[1]).toMatchObject({
      disposition: failed.disposition,
      blockingClass: "TRANSACTION_UNAVAILABLE",
      duplicateOccurrences: 1,
    });
    expect(h.dispatches()).toBe(2);
    expectConserved(h);
  });

  it("L4: unresolved outcomes are visible with a class, a gap and a blocked window", async () => {
    const h = harness();
    await h.account(env(notice(1)), okSwap(1));
    // Even a complete window never establishes completeness, a quiet window or qualification.
    expect(summary(h)).toMatchObject({
      accountingComplete: true,
      notificationCompletenessEstablished: false,
      quietWindowEstablished: false,
      qualificationEligible: false,
    });
    await h.account(env(notice(2)), rpcResult(null));
    const s = summary(h);
    expect(s).toMatchObject({
      accountingComplete: false,
      positionUnknown: 1,
      inWindow: { INGESTED: 1, UNRESOLVED: 1 },
      inWindowByClass: { TRANSACTION_UNAVAILABLE: 1 },
    });
    expect(s.gaps).toContainEqual({
      epoch: 1,
      signature: signatureOf(2),
      timeBasis: "HOST_RECEIPT",
      startMs: OBS_START,
      endMs: RECEIVED_AT,
      reason: "CPMM_TRANSACTION_UNAVAILABLE",
    });
    expectPlainFrozen(s);
  });

  it("L5: no-target and failed outcomes stay distinct, pending and never zero-swap evidence", async () => {
    const h = harness();
    await h.account(env(notice(1)), noTarget(1));
    await h.account(env(notice(2)), failedTx(2));
    const s = summary(h);
    expect(s.policyPending).toEqual({ noTargetSwap: 1, failedTransaction: 1 });
    expect(s.inWindow.POLICY_PENDING).toBe(2);
    expect(s.events.total).toBe(0);
    expect(s.accountingComplete).toBe(false);
    expect(s.gaps.map((g) => g.reason).sort()).toEqual([
      "CPMM_FAILED_TRANSACTION_POLICY_UNREVIEWED",
      "CPMM_NO_TARGET_SWAP_POLICY_UNREVIEWED",
    ]);
    expect(h.tracker.getEventsCount()).toBe(0);
    expect(s.quietWindowEstablished).toBe(false);
    expect(s.qualificationEligible).toBe(false);
  });

  it("L6: epoch intake; stale and unopened epochs make no request; refused openEpoch closes the epoch", async () => {
    const h = harness();
    expect(h.ledger.openEpoch({ epoch: 1, observationStartMs: OBS_START })).toEqual({
      status: "REFUSED",
      code: "EPOCH_NOT_INCREASING",
    });
    // The refusal closed epoch 1.
    expect(h.ledger.epochs()[0]!.state).toBe("CLOSED");
    expect(await h.account(env(notice(1), 1))).toMatchObject({
      status: "INVALID",
      code: "STALE_EPOCH",
      epoch: 1,
    });
    expect(await h.account(env(notice(1), 5))).toMatchObject({
      status: "INVALID",
      code: "EPOCH_NOT_OPEN",
      epoch: null,
    });
    expect(h.ledger.openEpoch({ epoch: 3, observationStartMs: OBS_START })).toMatchObject({
      status: "OPENED",
    });
    expect(await h.account(env(notice(1), 2))).toMatchObject({ code: "STALE_EPOCH", epoch: null });
    expect(h.ledger.openEpoch({ epoch: 4, observationStartMs: 0 } as never)).toEqual({
      status: "REFUSED",
      code: "EPOCH_INVALID",
    });
    expect(h.ledger.openEpoch({ epoch: 4, observationStartMs: 1, x: 1 } as never)).toMatchObject({
      code: "EPOCH_INVALID",
    });
    expect(h.adapter.resolveCalls).toBe(0);
    expect(h.dispatches()).toBe(0);
    expect(h.ledger.counters()).toMatchObject({ unattributedOccurrences: 2, openEpochRefused: 3 });
    expect(summary(h, win({ epoch: 1 })).accountingComplete).toBe(false);
    expectConserved(h);
  });

  it("L7: membership uses verified on-chain time only; after-cutoff is counted; fixtures never complete", async () => {
    const h = harness();
    await h.account(env(notice(1)), okSwap(1));
    const early = recorded(
      await h.account(
        env(notice(2, { blockTime: BLOCK_TIME - 60 })),
        okSwap(2, [swapIx("BUY")], { blockTime: BLOCK_TIME - 60 }),
      ),
    );
    expect(early.verifiedBlockTimeSec).toBe(BLOCK_TIME - 60);
    const s = summary(h);
    expect(s.inWindow.INGESTED).toBe(1); // the early record is outside the window
    expect(s.accountingComplete).toBe(true);
    expect(summary(h, win({ cutoff: { ...WINDOW.cutoff, slot: SLOT - 1 } }))).toMatchObject({
      afterCutoff: 2,
      accountingComplete: false,
    });
    expect(
      summary(h, win({ cutoff: { ...WINDOW.cutoff, provenance: "SYNTHETIC_FIXTURE" } }))
        .accountingComplete,
    ).toBe(false);
    // Host receipt never positions a record: a gap is host-only and the record stays unplaced.
    await h.account(env(notice(3)), rpcResult(null));
    const s3 = summary(h);
    expect(s3.positionUnknown).toBe(1);
    expect(s3.gaps.every((g) => g.timeBasis === "HOST_RECEIPT")).toBe(true);
    expect(h.ledger.records()[2]!.verifiedBlockTimeSec).toBeNull();
    // Window validation.
    for (const bad of [
      win({ windowEndMs: WINDOW.windowStartMs }),
      { ...WINDOW, extra: 1 },
      win({ cutoff: { ...WINDOW.cutoff, provenance: "GUESS" as never } }),
      win({ receiptFrontierMs: 0 }),
    ]) {
      expect(h.ledger.summarize(bad as CpmmAccountingWindow)).toEqual({
        status: "WINDOW_INVALID",
        code: "WINDOW_SHAPE",
      });
    }
    expect(h.ledger.summarize(win({ epoch: 9 }))).toMatchObject({ code: "EPOCH_NOT_RETAINED" });
    expect(h.ledger.summarize(win({ receiptFrontierMs: OBS_START - 1 }))).toMatchObject({
      code: "FRONTIER_BEFORE_EPOCH_START",
    });
  });

  it("L7c (regression): a window must end at or before the cutoff block time; invalid requests change nothing", async () => {
    const h = harness();
    await h.account(
      env(notice(1, { blockTime: BLOCK_TIME - 20 })),
      okSwap(1, [swapIx("BUY")], { blockTime: BLOCK_TIME - 20 }),
    );
    await h.account(env(notice(2)), noTarget(2));
    const cutoffAt = (blockTimeMs: number) => ({
      slot: SLOT + 100,
      blockTimeMs,
      provenance: "ON_CHAIN_BLOCK_TIME" as const,
    });
    const BEYOND = { status: "WINDOW_INVALID", code: "WINDOW_BEYOND_CUTOFF" };
    const state = () =>
      JSON.stringify([
        h.ledger.records(),
        h.ledger.epochs(),
        h.ledger.counters(),
        h.ledger.version,
        h.tracker.getEventsCount(),
        h.dispatches(),
      ]);
    const before = state();
    // Reproduction: the cutoff covers only part of [BT_MS - 30_000, BT_MS + 30_000).
    expect(h.ledger.summarize(win({ cutoff: cutoffAt(BT_MS - 10_000) }))).toEqual(BEYOND);
    // Cutoff before the window starts.
    expect(h.ledger.summarize(win({ cutoff: cutoffAt(WINDOW.windowStartMs - 1) }))).toEqual(BEYOND);
    // Window end one millisecond beyond the cutoff.
    expect(h.ledger.summarize(win({ cutoff: cutoffAt(WINDOW.windowEndMs - 1) }))).toEqual(BEYOND);
    // Invalid requests (this guard and the existing ones) leave every piece of state unchanged.
    expect(h.ledger.summarize(win({ epoch: 9 })).status).toBe("WINDOW_INVALID");
    expect(h.ledger.summarize(win({ windowEndMs: WINDOW.windowStartMs })).status).toBe(
      "WINDOW_INVALID",
    );
    expect(state()).toBe(before);
    // Window end exactly equal to the cutoff (the end is exclusive): accepted; the in-window
    // policy-pending record blocks.
    const equal = summary(h, win({ cutoff: cutoffAt(WINDOW.windowEndMs) }));
    expect(equal).toMatchObject({
      afterCutoff: 0,
      policyPending: { noTargetSwap: 1 },
      inWindow: { INGESTED: 1, POLICY_PENDING: 1 },
      accountingComplete: false,
    });
    // Window end before the cutoff: accepted; same accounting.
    expect(summary(h, win({ cutoff: cutoffAt(WINDOW.windowEndMs + 30_000) }))).toMatchObject({
      afterCutoff: 0,
      policyPending: { noTargetSwap: 1 },
      accountingComplete: false,
    });
    // The window shrunk to the cutoff holds only the ingested record and may be complete.
    expect(
      summary(h, win({ windowEndMs: BT_MS - 10_000, cutoff: cutoffAt(BT_MS - 10_000) })),
    ).toMatchObject({
      inWindow: { INGESTED: 1, POLICY_PENDING: 0 },
      afterCutoff: 1,
      accountingComplete: true,
    });
    expect(state()).toBe(before);
  });

  it("L8: lateness uses the owner's frozen frontier, not summary time; changes bump the version", async () => {
    const h = harness();
    await h.account(env(notice(1)), okSwap(1));
    const a = summary(h);
    const b = summary(h);
    expect(b).toEqual(a);
    expect(a.lateInWindow).toBe(0);
    expect(summary(h, win({ receiptFrontierMs: RECEIVED_AT - 1 }))).toMatchObject({
      lateInWindow: 1,
      accountingComplete: false,
    });
    // A late duplicate of an in-window record blocks.
    await h.ledger.account(env(notice(1, { receivedAtMs: RECEIVED_AT + 2_000 })));
    const c = summary(h);
    expect(c.lateInWindow).toBe(1);
    expect(c.accountingComplete).toBe(false);
    expect(c.ledgerVersion).toBeGreaterThan(a.ledgerVersion);
    expect(c.gaps.map((g) => g.reason)).toContain("CPMM_LATE_IN_WINDOW");
  });

  it("L9: lifecycle before dispatch, in flight and between events maps with exact counts; never rejects", async () => {
    const h = harness();
    const c = new AbortController();
    const hold = held();
    const p = h.account(env(notice(1)), hold.responder, { signal: c.signal });
    await flush();
    c.abort();
    expect(recorded(await p).blockingClass).toBe("CANCELLED");
    const hold2 = held();
    const p2 = h.account(env(notice(2)), hold2.responder);
    await flush();
    h.session.stop();
    expect(recorded(await p2).blockingClass).toBe("SESSION_ENDED");

    // Between resolution and ingestion: the session stops.
    const g = harness();
    g.adapter.after = () => {
      g.session.stop();
    };
    const stopped = recorded(await g.account(env(notice(1)), okSwap(1, TWO_SWAPS())));
    expect(stopped).toMatchObject({
      disposition: "INGESTION_INCOMPLETE",
      blockingClass: "INGEST_STOPPED",
      verifiedSlot: SLOT,
      ingestion: { status: "REFUSED_BEFORE_START", total: 2, accepted: 0, unattempted: 2 },
    });
    // Between events: the caller refuses at the second event.
    const k = harness();
    let armed = false;
    let checks = 0;
    k.adapter.after = () => {
      armed = true;
    };
    const between = recorded(
      await k.account(env(notice(1)), okSwap(1, TWO_SWAPS()), {
        refusal: () => (armed && ++checks >= 2 ? "STOP" : null),
      }),
    );
    expect(between).toMatchObject({
      blockingClass: "INGEST_STOPPED",
      ingestion: { status: "PARTIAL", accepted: 1, rejected: 0, unattempted: 1 },
    });
    expect(k.tracker.getEventsCount()).toBe(1);
  });

  it("L10: an empty window is never complete and the three flags stay false", () => {
    const h = harness();
    const s = summary(h);
    expect(s).toMatchObject({
      accountingComplete: false,
      notificationCompletenessEstablished: false,
      quietWindowEstablished: false,
      qualificationEligible: false,
    });
  });

  it("L11: construction binds adapter, tracker and binding; malformed options are refused", () => {
    const h = harness();
    const base = {
      binding: { poolAddress: POOL.poolAddress, candidateMint: POOL.candidateMint },
      adapter: h.adapter,
      tracker: h.tracker,
      limits: LIMITS,
    };
    const ctor = (over: Record<string, unknown>) => () =>
      new CpmmResolutionAccountingLedger({ ...base, ...over } as never);
    expect(ctor({})).not.toThrow();
    expect(ctor({ tracker: newTracker(FIXTURE_CPMM_TOKEN_0_VAULT) })).toThrow(/tracker identity/);
    expect(ctor({ tracker: newTracker(POOL.poolAddress, WSOL_MINT) })).toThrow(/tracker identity/);
    expect(ctor({ binding: { poolAddress: POOL.poolAddress, candidateMint: WSOL_MINT } })).toThrow(
      /adapter binding/,
    );
    expect(ctor({ binding: { ...base.binding, extra: 1 } })).toThrow(/binding/);
    expect(ctor({ adapter: { ...h.adapter, getBinding: () => base.binding } })).toThrow(
      /RaydiumCpmmTransactionSourceAdapter/,
    );
    expect(ctor({ extra: 1 })).toThrow(/exactly/);
    expect(ctor({ limits: { ...LIMITS, maxEpochs: 0 } })).toThrow(/maxEpochs/);
    expect(ctor({ limits: { maxSignatureRecords: 1, maxEpochs: 1 } })).toThrow(/limits/);
    expect(ctor({ limits: { ...LIMITS, maxSignatureRecords: 1.5 } })).toThrow(
      /maxSignatureRecords/,
    );
    expect(
      () => new CpmmResolutionAccountingLedger(JSON.parse('{"__proto__": {}}') as never),
    ).toThrow(/exactly/);
    // An event bound to another slot is a conflict, never ingested.
    return (async () => {
      h.adapter.after = (f) =>
        ({
          ...f,
          events: f.events.map((e) => ({ ...e, slot: e.slot + 1 })),
        }) as CpmmResolutionFact;
      const r = recorded(await h.account(env(notice(1)), okSwap(1)));
      expect(r).toMatchObject({ disposition: "UNRESOLVED", blockingClass: "BINDING_CONFLICT" });
      // Refused by the ledger's own binding check, before ingest() is called.
      expect(r.ingestion.status).toBe("NOT_CALLED");
      expect(r.verifiedSlot).toBeNull();
      expect(h.tracker.getEventsCount()).toBe(0);
    })();
  });

  it("L12: source boundaries (no network, timers, clock, abort, budget, session or coverage writes)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./CpmmResolutionAccountingLedger.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /setTimeout|setInterval|setImmediate|queueMicrotask/,
      /Date\.now|performance\.now/,
      /AbortController/,
      /\.budget\b|BudgetManager/,
      /PaperRequestSession|\.dispatch\(|\.stop\(|\.open\(/,
      /recordHeartbeat|recordObservationCheckpoint|recordCompletedRange|recordCollectionGap/,
      /process\.env/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "./ExactPoolHistoryEnumerator.js",
      "./RaydiumCpmmTransactionSourceAdapter.js",
      "./RaydiumCpmmSwapDecoder.js",
      "./RollingTradeFlowTracker.js",
    ]);
    expect(src).toMatch(/import \{ MAX_BLOCK_TIME_SEC \} from "\.\/RaydiumCpmmSwapDecoder\.js";/);
    expect(src).toMatch(/import type \{ RollingTradeFlowTracker, TradeEvent \}/);
  });

  it("L13: an epoch closed during pacing, in flight or before ingestion is EPOCH_CLOSED in the old epoch", async () => {
    // (a) During the session's pacing wait: no dispatch.
    const a = harness();
    await a.account(env(notice(1)), okSwap(1));
    a.script.push(okSwap(2));
    const paced = a.ledger.account(env(notice(2))); // no clock advance: pacing wait
    await flush();
    expect(a.dispatches()).toBe(1);
    expect(a.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START })).toMatchObject({
      status: "OPENED",
    });
    a.advance(2_500);
    const pa = recorded(await paced);
    expect([pa.epoch, pa.blockingClass, pa.factKind, pa.factCode]).toEqual([
      1,
      "EPOCH_CLOSED",
      "REQUEST_REFUSED",
      "CALLER_REFUSAL",
    ]);
    expect(a.dispatches()).toBe(1);

    // (b) In flight: one dispatch, refused at the post-await check, nothing ingested.
    const b = harness();
    const hold = held();
    const p = b.account(env(notice(1)), hold.responder);
    await flush();
    b.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    hold.result(txResult(signatureOf(1), [swapIx("BUY")]));
    const pb = recorded(await p);
    expect([pb.epoch, pb.blockingClass, pb.factKind, pb.factCode]).toEqual([
      1,
      "EPOCH_CLOSED",
      "LATE_RESPONSE",
      "LIFECYCLE_REFUSED",
    ]);
    expect(pb.ingestion.status).toBe("NOT_CALLED");
    expect(b.tracker.getEventsCount()).toBe(0);
    expect(b.dispatches()).toBe(1);
    const s2 = summary(b, win({ epoch: 2 }));
    expect(s2).toMatchObject({ otherEpochFirstRecords: 1, inWindow: { UNRESOLVED: 0 } });
    expect(s2.gaps).toEqual([]);
    expect(summary(b).inWindowByClass).toEqual({ EPOCH_CLOSED: 1 });

    // (c) Between resolution and ingestion: all events unattempted.
    const c = harness();
    c.adapter.after = () => {
      c.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    };
    const pc = recorded(await c.account(env(notice(1)), okSwap(1, TWO_SWAPS())));
    expect(pc).toMatchObject({
      epoch: 1,
      disposition: "INGESTION_INCOMPLETE",
      blockingClass: "EPOCH_CLOSED",
      ingestion: { status: "REFUSED_BEFORE_START", total: 2, accepted: 0, unattempted: 2 },
    });
    expect(c.tracker.getEventsCount()).toBe(0);

    // (d) Epoch close plus caller refusal: EPOCH_CLOSED is recorded.
    const d = harness();
    const hd = held();
    let refuse = false;
    const pd = d.account(env(notice(1)), hd.responder, { refusal: () => (refuse ? "X" : null) });
    await flush();
    refuse = true;
    d.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    hd.result(txResult(signatureOf(1), [swapIx("BUY")]));
    expect(recorded(await pd).blockingClass).toBe("EPOCH_CLOSED");

    // (e) Session stop and genuine transport errors keep their own precedence.
    const e = harness();
    const he = held();
    const pe = e.account(env(notice(1)), he.responder);
    await flush();
    e.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    e.session.stop();
    expect(recorded(await pe).blockingClass).toBe("SESSION_ENDED");
    const f = harness();
    const hf = held();
    const pf = f.account(env(notice(1)), hf.responder);
    await flush();
    f.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    hf.fail();
    expect(recorded(await pf)).toMatchObject({
      blockingClass: "TRANSACTION_UNAVAILABLE",
      factKind: "TRANSPORT_FAILED",
    });
  });

  it("L14: a re-entrant openEpoch from the caller's callback stops ingestion between events", async () => {
    const h = harness();
    let armed = false;
    let checks = 0;
    h.adapter.after = () => {
      armed = true;
    };
    const r = recorded(
      await h.account(env(notice(1)), okSwap(1, TWO_SWAPS()), {
        refusal: () => {
          // The caller runs before the epoch check, so this close is seen at the same check.
          if (armed && ++checks === 2)
            h.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
          return null;
        },
      }),
    );
    expect(r).toMatchObject({
      epoch: 1,
      disposition: "INGESTION_INCOMPLETE",
      blockingClass: "EPOCH_CLOSED",
      ingestion: { status: "PARTIAL", total: 2, accepted: 1, rejected: 0, unattempted: 1 },
    });
    // The accepted event is preserved in the tracker.
    expect(h.tracker.getEventsCount()).toBe(1);
    expect(summary(h).accountingComplete).toBe(false);
    expect(summary(h, win({ epoch: 2 })).otherEpochFirstRecords).toBe(1);
  });

  it("L15: cross-epoch duplicates are accounted where received and never satisfy an empty window", async () => {
    const h = harness();
    await h.account(env(notice(1)), okSwap(1));
    await h.account(env(notice(2)), rpcResult(null));
    h.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    const W2 = win({ epoch: 2 });
    expect((await h.ledger.account(env(notice(1), 2))).status).toBe("DUPLICATE");
    let s = summary(h, W2);
    expect(s.epoch.duplicates).toEqual({ sameEpoch: 0, crossEpoch: 1 });
    expect(s.crossEpochDuplicates).toEqual({ referencedIngested: 1, blocking: 0 });
    expect(s.events.total).toBe(0);
    expect(s.accountingComplete).toBe(false); // a reference never supplies non-emptiness
    await h.account(env(notice(3), 2), okSwap(3));
    s = summary(h, W2);
    expect(s.accountingComplete).toBe(true);
    expect(s.events).toMatchObject({ total: 1, accepted: 1 }); // referenced events not recounted
    // A reference to an unresolved (position unknown) record blocks.
    await h.ledger.account(env(notice(2), 2));
    s = summary(h, W2);
    expect(s.crossEpochDuplicates).toEqual({ referencedIngested: 1, blocking: 1 });
    expect(s.accountingComplete).toBe(false);
    expect(s.gaps.map((g) => g.reason)).toContain("CPMM_CROSS_EPOCH_DUPLICATE_BLOCKING");
    expect(h.dispatches()).toBe(3);
    // A reference to a PENDING record blocks until and unless it is INGESTED.
    const g = harness();
    const hold = held();
    const p = g.account(env(notice(1)), hold.responder);
    await flush();
    g.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    await g.ledger.account(env(notice(1), 2));
    expect(summary(g, win({ epoch: 2 })).crossEpochDuplicates.blocking).toBe(1);
    hold.result(txResult(signatureOf(1), [swapIx("BUY")]));
    await p;
    expect(summary(g, win({ epoch: 2 })).crossEpochDuplicates.blocking).toBe(1); // EPOCH_CLOSED
    expectConserved(h);
    expectConserved(g);
  });

  it("L16: contradictory duplicates block both epochs and never alter the first record", async () => {
    const h = harness();
    const first = recorded(await h.account(env(notice(1)), okSwap(1)));
    await h.account(env(notice(2)), okSwap(2));
    expect(summary(h).accountingComplete).toBe(true);
    h.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    await h.account(env(notice(3), 2), okSwap(3));
    expect(summary(h, win({ epoch: 2 })).accountingComplete).toBe(true);
    const d = await h.ledger.account(env(notice(1, { slot: SLOT + 1 }), 2));
    expect(d).toMatchObject({ status: "DUPLICATE", detail: { agreement: "SLOT_CONFLICT" } });
    const s1 = summary(h);
    const s2 = summary(h, win({ epoch: 2 }));
    expect(s1.metadataConflicts).toEqual({ references: 0, records: 1 });
    expect(s2.metadataConflicts).toEqual({ references: 1, records: 0 });
    expect(s1.accountingComplete).toBe(false);
    expect(s2.accountingComplete).toBe(false);
    const after = h.ledger.records()[0]!;
    expect(after.metadataConflict).toBe(true);
    expect({
      ...after,
      metadataConflict: false,
      duplicateOccurrences: 0,
      duplicateDetails: [],
      duplicateDetailsDropped: 0,
    }).toEqual({ ...first });
    // Block time: against the verified value when the first notification had none.
    const g = harness();
    await g.account(env(notice(1, { omitBlockTime: true })), okSwap(1));
    expect(g.ledger.records()[0]!.verifiedBlockTimeSec).toBe(BLOCK_TIME);
    expect(await g.ledger.account(env(notice(1, { omitBlockTime: true })))).toMatchObject({
      detail: { agreement: "AGREES" },
    });
    expect(g.ledger.records()[0]!.metadataConflict).toBe(false);
    expect(await g.ledger.account(env(notice(1, { blockTime: BLOCK_TIME + 1 })))).toMatchObject({
      detail: { agreement: "BLOCK_TIME_CONFLICT" },
    });
    expect(g.ledger.records()[0]!.metadataConflict).toBe(true);
    expect(summary(g).accountingComplete).toBe(false);
    // A conflicting claim made while the first was PENDING is detected once it is verified.
    const k = harness();
    const hold = held();
    const p = k.account(env(notice(1, { omitBlockTime: true })), hold.responder);
    await flush();
    expect(await k.ledger.account(env(notice(1, { blockTime: BLOCK_TIME + 5 })))).toMatchObject({
      detail: { agreement: "AGREES", firstDispositionAtReceipt: "PENDING" },
    });
    hold.result(txResult(signatureOf(1), [swapIx("BUY")]));
    await p;
    expect(k.ledger.records()[0]!.metadataConflict).toBe(true);
    expect(summary(k).metadataConflicts).toEqual({ references: 1, records: 1 });
  });

  it("L17: record overflow refuses before the adapter; details are bounded; counts stay exact", async () => {
    const h = harness({ limits: { maxSignatureRecords: 1, maxDuplicateDetailsPerRecord: 1 } });
    await h.account(env(notice(1)), okSwap(1));
    const reserved = h.adapter.reservedSignatureCount;
    expect(await h.account(env(notice(2)))).toEqual({
      status: "CAPACITY_REFUSED",
      occurrence: 2,
      epoch: 1,
      code: "RECORD_CAPACITY",
    });
    expect(h.adapter.resolveCalls).toBe(1);
    expect(h.adapter.reservedSignatureCount).toBe(reserved);
    expect(h.dispatches()).toBe(1);
    expect((await h.ledger.account(env(notice(1)))).status).toBe("DUPLICATE");
    const third = await h.ledger.account(env(notice(1)));
    expect(third).toMatchObject({ status: "DUPLICATE", detailRetained: false });
    expect(h.ledger.records()[0]).toMatchObject({
      duplicateOccurrences: 2,
      duplicateDetailsDropped: 1,
    });
    expect(h.ledger.records()[0]!.duplicateDetails).toHaveLength(1);
    const s = summary(h);
    expect(s.accountingComplete).toBe(false);
    expect(s.ledger.recordCapacityRefused).toBe(1);
    expect(s.gaps.map((g) => g.reason)).toContain("CPMM_RECORD_CAPACITY");
    // Overflow in a later epoch also blocks an earlier, otherwise complete epoch (ledger-wide).
    const g = harness({ limits: { maxSignatureRecords: 2 } });
    await g.account(env(notice(1)), okSwap(1));
    g.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    await g.account(env(notice(2), 2), okSwap(2));
    expect(summary(g).accountingComplete).toBe(true);
    expect((await g.account(env(notice(3), 2))).status).toBe("CAPACITY_REFUSED");
    expect(summary(g)).toMatchObject({
      accountingComplete: false,
      epoch: { capacityRefused: 0 },
      ledger: { recordCapacityRefused: 1 },
    });
    expect(cpmmSaturatingIncrement(1)).toEqual({ value: 2, saturated: false });
    expect(cpmmSaturatingIncrement(Number.MAX_SAFE_INTEGER)).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      saturated: true,
    });
    expectConserved(h);
  });

  it("L17b (regression): after the detail limit, late and conflicting duplicates still block", async () => {
    const h = harness({ limits: { maxDuplicateDetailsPerRecord: 1 } });
    await h.account(env(notice(1)), okSwap(1));
    await h.ledger.account(env(notice(1))); // the only retained detail: agrees, on time
    expect(summary(h).accountingComplete).toBe(true);
    // Late, beyond the frozen frontier, detail not retained.
    const late = await h.ledger.account(env(notice(1, { receivedAtMs: RECEIVED_AT + 3_000 })));
    expect(late).toMatchObject({ status: "DUPLICATE", detailRetained: false });
    let s = summary(h);
    expect(s.lateInWindow).toBe(1);
    expect(s.accountingComplete).toBe(false);
    expect(summary(h, win({ receiptFrontierMs: RECEIVED_AT + 3_000 })).accountingComplete).toBe(
      true,
    );
    // A conflict whose detail is not retained.
    const conflict = await h.ledger.account(env(notice(1, { slot: SLOT + 7 })));
    expect(conflict).toMatchObject({
      detailRetained: false,
      detail: { agreement: "SLOT_CONFLICT" },
    });
    s = summary(h, win({ receiptFrontierMs: RECEIVED_AT + 3_000 }));
    expect(s.metadataConflicts).toEqual({ references: 1, records: 1 });
    expect(s.accountingComplete).toBe(false);
    const rec = h.ledger.records()[0]!;
    expect(rec.duplicateDetails.map((d) => d.agreement)).toEqual(["AGREES"]);
    expect(rec.metadataConflict).toBe(true);
    // Cross-epoch, after truncation: late reference to an INGESTED record blocks.
    const g = harness({ limits: { maxDuplicateDetailsPerRecord: 1 } });
    await g.account(env(notice(1)), okSwap(1));
    await g.ledger.account(env(notice(1)));
    g.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    await g.account(env(notice(2), 2), okSwap(2));
    const W2 = win({ epoch: 2 });
    expect(summary(g, W2).accountingComplete).toBe(true);
    const lateCross = await g.ledger.account(
      env(notice(1, { receivedAtMs: RECEIVED_AT + 3_000 }), 2),
    );
    expect(lateCross).toMatchObject({ detailRetained: false });
    expect(summary(g, W2)).toMatchObject({ lateInWindow: 1, accountingComplete: false });
    expectConserved(h);
    expectConserved(g);
  });

  it("L18: epoch capacity refuses later epochs and envelopes without a request, visibly", async () => {
    const h = harness({ limits: { maxEpochs: 1 } });
    await h.account(env(notice(1)), okSwap(1));
    expect(summary(h).accountingComplete).toBe(true);
    expect(h.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START })).toEqual({
      status: "REFUSED",
      code: "EPOCH_CAPACITY",
    });
    expect(h.ledger.epochs()[0]!.state).toBe("CLOSED");
    expect(await h.account(env(notice(2), 2))).toMatchObject({
      status: "CAPACITY_REFUSED",
      code: "EPOCH_CAPACITY",
      epoch: null,
    });
    expect(await h.account(env(notice(3), 1))).toMatchObject({ code: "STALE_EPOCH", epoch: 1 });
    expect(h.dispatches()).toBe(1);
    expect(h.ledger.openEpoch({ epoch: 3, observationStartMs: OBS_START })).toMatchObject({
      code: "EPOCH_CAPACITY",
    });
    const s = summary(h);
    expect(s.accountingComplete).toBe(false);
    expect(s.ledger).toMatchObject({ epochCapacityRefused: 1, openEpochRefused: 2 });
    expectConserved(h);
  });

  it("L19: receipt time must agree and not precede the epoch; no request either way", async () => {
    const h = harness();
    const n = notice(1);
    expect(await h.account({ ...env(n), hostReceivedAtMs: RECEIVED_AT + 1 })).toMatchObject({
      status: "INVALID",
      code: "RECEIPT_TIME_DISAGREEMENT",
      epoch: 1,
    });
    const early = notice(2, { receivedAtMs: OBS_START - 1 });
    expect(await h.account(env(early))).toMatchObject({ code: "RECEIPT_BEFORE_EPOCH_START" });
    expect(h.adapter.resolveCalls).toBe(0);
    expect(recorded(await h.account(env(n), okSwap(1))).disposition).toBe("INGESTED");
    const s = summary(h);
    expect(s.epoch.invalid).toMatchObject({
      RECEIPT_TIME_DISAGREEMENT: 1,
      RECEIPT_BEFORE_EPOCH_START: 1,
    });
    expect(s.accountingComplete).toBe(false);
    // Envelope, gate and notification validation; codes match the adapter's.
    expect(await h.account({ ...env(n), extra: 1 })).toMatchObject({
      code: "ENVELOPE_INVALID",
      epoch: null,
    });
    expect(await h.ledger.account(env(n), { bogus: 1 } as never)).toMatchObject({
      code: "GATE_INVALID",
    });
    const probe = harness();
    for (const bad of [
      { ...n, extra: 1 },
      { ...n, signature: "x" },
      { ...n, slot: -1 },
      { ...n, blockTime: 0 },
      { ...n, receivedAtMs: 0 },
      JSON.parse(`{"__proto__": 1, "signature": "${n.signature}", "slot": 1, "receivedAtMs": 1}`),
    ]) {
      const r = await h.ledger.account({
        notification: bad,
        epoch: 1,
        hostReceivedAtMs: RECEIVED_AT,
      });
      const a = await probe.adapter.resolve(bad);
      expect(a.kind).toBe("INVALID_NOTIFICATION");
      expect(r).toMatchObject({ status: "INVALID", code: "NOTIFICATION_INVALID", detail: a.code });
    }
    expect(probe.dispatches()).toBe(0);
    expectConserved(h);
  });

  it("L20: only decoded kinds gain verified metadata; a matched time positions but never resolves", async () => {
    const h = harness();
    const v = (r: CpmmAccountResult) => {
      const x = recorded(r);
      return [x.verifiedSlot, x.verifiedBlockTimeSec];
    };
    expect(
      v(await h.account(env(notice(1)), okSwap(1, [swapIx("BUY")], { slot: SLOT + 1 }))),
    ).toEqual([null, null]);
    expect(
      v(await h.account(env(notice(2)), okSwap(2, [swapIx("BUY")], { blockTime: BLOCK_TIME + 1 }))),
    ).toEqual([null, null]);
    expect(
      v(await h.account(env(notice(3)), okSwap(3, [swapIx("BUY")], { blockTime: null }))),
    ).toEqual([null, null]);
    expect(v(await h.account(env(notice(4)), okSwap(99)))).toEqual([null, null]);
    expect(v(await h.account(env(notice(5)), rpcResult(null)))).toEqual([null, null]);
    expect(
      v(
        await h.account(
          env(notice(6)),
          reply(() => "x"),
        ),
      ),
    ).toEqual([null, null]);
    expect(v(await h.account(env(notice(7)), noTarget(7)))).toEqual([SLOT, BLOCK_TIME]);
    expect(v(await h.account(env(notice(8, { omitBlockTime: true })), noTarget(8)))).toEqual([
      SLOT,
      null,
    ]);
    expect(v(await h.account(env(notice(9)), failedTx(9)))).toEqual([SLOT, BLOCK_TIME]);
    expect(v(await h.account(env(notice(10, { blockTime: null })), failedTx(10)))).toEqual([
      SLOT,
      null,
    ]);
    const v9 = txResult(signatureOf(11), [swapIx("BUY")]);
    v9.version = "v9";
    expect(v(await h.account(env(notice(11)), rpcResult(v9)))).toEqual([SLOT, BLOCK_TIME]);
    // In flight then late (post-await refusal): no verified metadata.
    const hold = held();
    let refuse = false;
    const p = h.account(env(notice(12)), hold.responder, { refusal: () => (refuse ? "X" : null) });
    await flush();
    refuse = true;
    hold.result(txResult(signatureOf(12), [swapIx("BUY")]));
    expect(v(await p)).toEqual([null, null]);
    // Positioning: a matched POLICY_PENDING record in the window blocks; outside it does not.
    const g = harness();
    await g.account(env(notice(1)), okSwap(1));
    await g.account(
      env(notice(2, { blockTime: BLOCK_TIME - 100 })),
      noTarget(2, { blockTime: BLOCK_TIME - 100 }),
    );
    let s = summary(g);
    expect(s.policyPending.noTargetSwap).toBe(0);
    expect(s.accountingComplete).toBe(true);
    await g.account(env(notice(3)), noTarget(3));
    s = summary(g);
    expect(s.policyPending.noTargetSwap).toBe(1);
    expect(s.positionUnknown).toBe(0);
    expect(s.accountingComplete).toBe(false);
  });

  it("L21: conservation and immutable snapshots after mixed concurrent operations", async () => {
    const h = harness({ limits: { maxSignatureRecords: 4, maxDuplicateDetailsPerRecord: 2 } });
    const holdA = held();
    const pA = h.account(env(notice(1)), holdA.responder);
    expectConserved(h);
    const snapRecords = h.ledger.records();
    const snapEpochs = h.ledger.epochs();
    const snapCounters = h.ledger.counters();
    const snapSummary = summary(h);
    const frozenCopy = JSON.stringify([snapRecords, snapEpochs, snapCounters, snapSummary]);
    await flush();
    const concurrent = await Promise.all([
      h.ledger.account(env(notice(1))),
      h.ledger.account(env(notice(1, { slot: SLOT + 1 }))),
      h.ledger.account(env(notice(1, { receivedAtMs: RECEIVED_AT + 4_000 }))),
      h.ledger.account({ ...env(notice(9)), hostReceivedAtMs: 5 }),
      h.ledger.account(env(notice(9), 7)),
      h.ledger.account(null as never),
    ]);
    expect(concurrent.map((r) => r.status)).toEqual([
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
      "INVALID",
      "INVALID",
      "INVALID",
    ]);
    expect(concurrent.map((r) => r.occurrence)).toEqual([2, 3, 4, 5, 6, 7]);
    expectConserved(h);
    expect(h.ledger.records()[0]).toMatchObject({
      disposition: "PENDING",
      duplicateOccurrences: 3,
      duplicateDetailsDropped: 1,
    });
    h.ledger.openEpoch({ epoch: 2, observationStartMs: OBS_START });
    expectConserved(h);
    await h.ledger.account(env(notice(1), 2));
    holdA.result(txResult(signatureOf(1), [swapIx("BUY")]));
    expect(recorded(await pA).blockingClass).toBe("EPOCH_CLOSED");
    await h.account(env(notice(2), 2), okSwap(2));
    await h.account(env(notice(3), 2), noTarget(3));
    await h.account(env(notice(4), 2), rpcResult(null));
    expect((await h.account(env(notice(5), 2))).status).toBe("CAPACITY_REFUSED");
    expectConserved(h);
    // Earlier snapshots are frozen and unchanged.
    for (const x of [snapRecords, snapEpochs, snapCounters, snapSummary]) expectPlainFrozen(x);
    expect(JSON.stringify([snapRecords, snapEpochs, snapCounters, snapSummary])).toBe(frozenCopy);
    expect(snapSummary.ledgerVersion).toBeLessThan(h.ledger.version);
    // Version: occurrences + terminal transitions + openEpoch calls.
    const c = h.ledger.counters();
    const terminal = h.ledger.records().filter((r) => r.disposition !== "PENDING").length;
    expect(h.ledger.version).toBe(c.occurrences + terminal + 2);
    expect(c).toMatchObject({ occurrences: 12, unattributedOccurrences: 2, saturated: false });
    expect(h.ledger.records().map((r) => r.disposition)).toEqual([
      "UNRESOLVED",
      "INGESTED",
      "POLICY_PENDING",
      "UNRESOLVED",
    ]);
    const s1 = summary(h);
    expect(s1.metadataConflicts.records).toBe(1);
    expect(s1.lateInWindow).toBe(1);
    expect(s1.accountingComplete).toBe(false);
  });

  it("L22 (item 15): getBinding() is a read-only frozen copy of the construction binding", () => {
    const h = harness();
    const v = h.ledger.version;
    const a = h.ledger.getBinding();
    const b = h.ledger.getBinding();
    expect(a).toEqual(h.adapter.getBinding());
    expect(Object.keys(a)).toEqual(["poolAddress", "candidateMint"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(() => {
      (a as { poolAddress: string }).poolAddress = "x";
    }).toThrow();
    expect(h.ledger.getBinding()).toEqual(b);
    expect(h.ledger.version).toBe(v);
  });
});
