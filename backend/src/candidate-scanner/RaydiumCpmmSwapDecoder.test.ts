/**
 * Raydium CPMM swap decoder: synthetic offline tests (assessment §8.38.17, items 8–10).
 *
 * Every payload is a SYNTHETIC in-memory `getTransaction` response in `encoding: "json"`, built
 * from literal byte layouts (instruction data, TransferChecked, SwapEvent); nothing is captured
 * evidence. Pool contexts are real outputs of the implemented Stage 1 adapter on its fixtures.
 */
import { createHash } from "node:crypto";
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
  CANONICAL_CPMM_AUTH_BUMP,
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateSuccess,
} from "./RaydiumCpmmPoolStateAdapter.js";
import {
  CPMM_DECODER_LIMITS,
  CPMM_SWAP_BASE_INPUT_DISCRIMINATOR,
  CPMM_SWAP_BASE_OUTPUT_DISCRIMINATOR,
  CPMM_SWAP_EVENT_DISCRIMINATOR,
  MAX_BLOCK_TIME_SEC,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
  decodeRaydiumCpmmTransactionSwaps,
  type DecodeRaydiumCpmmTransactionResult,
} from "./RaydiumCpmmSwapDecoder.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";

type Loose = ReturnType<typeof JSON.parse>;

// ---------------------------------------------------------------------------------------------
// Literal layouts
// ---------------------------------------------------------------------------------------------

const sha8 = (s: string) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
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

const swapData = (kind: "IN" | "OUT", p1: bigint, p2: bigint) =>
  Buffer.concat([
    Buffer.from(
      kind === "IN" ? CPMM_SWAP_BASE_INPUT_DISCRIMINATOR : CPMM_SWAP_BASE_OUTPUT_DISCRIMINATOR,
    ),
    u64(p1),
    u64(p2),
  ]);
const transferCheckedData = (amount: bigint, decimals: number) =>
  Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]);

interface EventFields {
  pool: string;
  inputAmount: bigint;
  outputAmount: bigint;
  baseInput: boolean;
  inputMint: string;
  outputMint: string;
  inFee?: bigint;
  outFee?: bigint;
  boolByte?: number;
}
const swapEventBytes = (e: EventFields) =>
  Buffer.concat([
    Buffer.from(CPMM_SWAP_EVENT_DISCRIMINATOR),
    Buffer.from(new PublicKey(e.pool).toBytes()),
    u64(123n),
    u64(456n),
    u64(e.inputAmount),
    u64(e.outputAmount),
    u64(e.inFee ?? 0n),
    u64(e.outFee ?? 0n),
    Buffer.from([e.boolByte ?? (e.baseInput ? 1 : 0)]),
    Buffer.from(new PublicKey(e.inputMint).toBytes()),
    Buffer.from(new PublicKey(e.outputMint).toBytes()),
    u64(7n),
    u64(0n),
    Buffer.from([0]),
  ]);

// ---------------------------------------------------------------------------------------------
// Pool contexts from the real Stage 1 adapter
// ---------------------------------------------------------------------------------------------

const CANDIDATE_A = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // 0x01 * 32 < WSOL
const CANDIDATE_B = "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG"; // 0xff * 32 > WSOL

function adaptedPool(orientation: "A" | "B", candidateDecimals = 6): RaydiumCpmmPoolStateSuccess {
  const a = orientation === "A";
  const candidate = a ? CANDIDATE_A : CANDIDATE_B;
  const vault = (mint: string, raw: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58: mint,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount: raw,
      state: 1,
    });
  const r = adaptRaydiumCpmmPoolState({
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: candidate },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: a ? candidate : WSOL_MINT,
        token1MintBase58: a ? WSOL_MINT : candidate,
        mint0Decimals: a ? candidateDecimals : 9,
        mint1Decimals: a ? 9 : candidateDecimals,
        status: 0,
        creatorFeeOn: 0,
        enableCreatorFee: false,
      }),
      ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault0Account: {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: vault(a ? candidate : WSOL_MINT, a ? 10_000_000_000n : 50_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault1Account: {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: vault(a ? WSOL_MINT : candidate, a ? 50_000_000_000n : 10_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
  });
  if (!r.ok) throw new Error(`adapter refused the fixture: ${r.refusalCode} ${r.message}`);
  return r;
}

const POOL_A = adaptedPool("A");
const POOL_B = adaptedPool("B");

// ---------------------------------------------------------------------------------------------
// Synthetic json-encoding transaction builder
// ---------------------------------------------------------------------------------------------

interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
  children?: Ix[];
  /** SwapEvent bytes (or raw data lines) logged directly in this frame, before its children. */
  logData?: string[] | undefined;
  stackHeightOverride?: unknown;
}

interface TxSpec {
  signers: string[];
  top: Ix[];
  version?: unknown;
  loaded?: string[];
  blockTime?: unknown;
  err?: unknown;
  logs?: "GENERATE" | "NONE" | string[];
  innerNull?: boolean;
  slot?: unknown;
}

const PAYER = key(1);
const ROUTER = key(2);
const ROUTER_PDA = key(3);
const USER_WSOL = key(4);
const USER_TOKEN = key(5);
const AMM_CONFIG = key(6);
const OBSERVATION = key(7);
const OTHER_POOL = key(8);
const OTHER_VAULT_0 = key(9);
const OTHER_VAULT_1 = key(10);
const SIGNER_2 = key(11);
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function build(spec: TxSpec): Loose {
  const keys: string[] = [...spec.signers];
  const loaded = spec.loaded ?? [];
  const idx = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
  };
  const collect = (ix: Ix) => {
    if (!loaded.includes(ix.program)) idx(ix.program);
    for (const a of ix.accounts) if (!loaded.includes(a)) idx(a);
    ix.children?.forEach(collect);
  };
  spec.top.forEach(collect);
  const all = [...keys, ...loaded];
  const at = (k: string) => all.indexOf(k);
  const compile = (ix: Ix, height: number | null) => ({
    programIdIndex: at(ix.program),
    accounts: ix.accounts.map(at),
    data: encodeBase58(ix.data),
    ...(ix.stackHeightOverride !== undefined
      ? { stackHeight: ix.stackHeightOverride }
      : height === null
        ? { stackHeight: null }
        : { stackHeight: height }),
  });
  const inner: Loose[] = [];
  spec.top.forEach((t, o) => {
    const list: Loose[] = [];
    const walk = (ix: Ix, h: number) => {
      for (const c of ix.children ?? []) {
        list.push(compile(c, h));
        walk(c, h + 1);
      }
    };
    walk(t, 2);
    if (list.length > 0) inner.push({ index: o, instructions: list });
  });
  const logs: string[] = [];
  const log = (ix: Ix, depth: number) => {
    logs.push(`Program ${ix.program} invoke [${depth}]`);
    for (const d of ix.logData ?? []) logs.push(`Program data: ${d}`);
    for (const c of ix.children ?? []) log(c, depth + 1);
    logs.push(`Program ${ix.program} consumed 1000 of 200000 compute units`);
    logs.push(`Program ${ix.program} success`);
  };
  spec.top.forEach((t) => log(t, 1));
  const version = spec.version === undefined ? (loaded.length > 0 ? 0 : "legacy") : spec.version;
  return {
    slot: spec.slot ?? 312_000_000,
    blockTime: spec.blockTime === undefined ? 1_794_829_420 : spec.blockTime,
    version,
    transaction: {
      signatures: spec.signers.map((_, i) => signatureOf(i + 1)),
      message: {
        header: {
          numRequiredSignatures: spec.signers.length,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        accountKeys: keys,
        recentBlockhash: key(99),
        instructions: spec.top.map((t) => compile(t, null)),
        ...(version === 0
          ? {
              addressTableLookups: [
                {
                  accountKey: key(98),
                  writableIndexes: loaded.map((_, i) => i),
                  readonlyIndexes: [],
                },
              ],
            }
          : {}),
      },
    },
    meta: {
      err: spec.err === undefined ? null : spec.err,
      fee: 5000,
      innerInstructions: spec.innerNull ? null : inner,
      loadedAddresses: { writable: loaded, readonly: [] },
      logMessages: spec.logs === "NONE" ? null : Array.isArray(spec.logs) ? spec.logs : logs,
    },
  };
}

interface SwapSpec {
  pool?: RaydiumCpmmPoolStateSuccess;
  side: "BUY" | "SELL";
  kind?: "IN" | "OUT";
  payer?: string;
  inAmount?: bigint;
  outAmount?: bigint;
  p1?: bigint;
  p2?: bigint;
  event?: boolean | Partial<EventFields> | string[];
}

/** A target swap frame with its two literal TransferChecked children. */
function swapIx(s: SwapSpec): Ix {
  const pool = s.pool ?? POOL_A;
  const buy = s.side === "BUY";
  const kind = s.kind ?? "IN";
  const inAmount = s.inAmount ?? (buy ? 1_000_000_000n : 2_500_000n);
  const outAmount = s.outAmount ?? (buy ? 2_500_000n : 900_000_000n);
  const inVault = buy ? pool.quoteVaultAddress : pool.baseVaultAddress;
  const outVault = buy ? pool.baseVaultAddress : pool.quoteVaultAddress;
  const inMint = buy ? WSOL_MINT : pool.candidateMint;
  const outMint = buy ? pool.candidateMint : WSOL_MINT;
  const userIn = buy ? USER_WSOL : USER_TOKEN;
  const userOut = buy ? USER_TOKEN : USER_WSOL;
  const dec = (m: string) => (m === WSOL_MINT ? 9 : pool.baseDecimals);
  const payer = s.payer ?? PAYER;
  const p1 = s.p1 ?? (kind === "IN" ? inAmount : inAmount + 10n);
  const p2 = s.p2 ?? (kind === "IN" ? outAmount - 1n : outAmount);
  let logData: string[] | undefined;
  if (Array.isArray(s.event)) logData = s.event;
  else if (s.event !== false) {
    const overrides = typeof s.event === "object" ? s.event : {};
    logData = [
      swapEventBytes({
        pool: pool.poolAddress,
        inputAmount: inAmount,
        outputAmount: outAmount,
        baseInput: kind === "IN",
        inputMint: inMint,
        outputMint: outMint,
        ...overrides,
      }).toString("base64"),
    ];
  }
  return {
    program: RAYDIUM_CPMM_PROGRAM_ID,
    accounts: [
      payer,
      RAYDIUM_CPMM_AUTHORITY,
      AMM_CONFIG,
      pool.poolAddress,
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
    data: swapData(kind, p1, p2),
    logData,
    children: [
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [userIn, inMint, inVault, payer],
        data: transferCheckedData(inAmount, dec(inMint)),
      },
      {
        program: SPL_TOKEN_PROGRAM_ID,
        accounts: [outVault, outMint, userOut, RAYDIUM_CPMM_AUTHORITY],
        data: transferCheckedData(outAmount, dec(outMint)),
      },
    ],
  };
}

const router = (children: Ix[], extra: string[] = []): Ix => ({
  program: ROUTER,
  accounts: [ROUTER_PDA, ...extra],
  data: Uint8Array.from([1, 2, 3]),
  children,
});
const RECEIPT = { receiptTimestampMs: 1_794_829_421_500 };
const decode = (
  payload: unknown,
  pool: RaydiumCpmmPoolStateSuccess = POOL_A,
  options: unknown = RECEIPT,
) => decodeRaydiumCpmmTransactionSwaps(payload, pool, options as typeof RECEIPT);

function expectRefused(r: DecodeRaydiumCpmmTransactionResult, reason: string, detail?: string) {
  const shown = JSON.stringify(r, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  expect(r.ok, shown).toBe(false);
  expect(r.status, shown).toBe("UNRESOLVED_EVIDENCE");
  if (r.status === "UNRESOLVED_EVIDENCE") {
    expect(r.reason, r.message).toBe(reason);
    if (detail !== undefined) expect(r.detail, r.message).toBe(detail);
  }
  expect(r.events).toEqual([]);
}
function expectDecoded(r: DecodeRaydiumCpmmTransactionResult, n = 1) {
  expect(
    r.status,
    JSON.stringify(r, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
  ).toBe("SWAP_DECODED");
  expect(r.events).toHaveLength(n);
  return r as Extract<DecodeRaydiumCpmmTransactionResult, { status: "SWAP_DECODED" }>;
}
/** Mutates one compiled instruction (outer o, position pos: 0 = top-level, k = inner k-1). */
function editIx(p: Loose, o: number, pos: number, edit: (ix: Loose) => void) {
  if (pos === 0) edit(p.transaction.message.instructions[o]);
  else edit(p.meta.innerInstructions.find((g: Loose) => g.index === o).instructions[pos - 1]);
  return p;
}
const indexOf = (p: Loose, k: string) => {
  const all = [...p.transaction.message.accountKeys, ...p.meta.loadedAddresses.writable];
  const i = all.indexOf(k);
  if (i < 0) throw new Error(`key ${k} not in transaction`);
  return i;
};
const simpleBuy = (extra: Partial<TxSpec> = {}, s: Partial<SwapSpec> = {}) =>
  build({ signers: [PAYER], top: [swapIx({ side: "BUY", ...s })], ...extra });

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("Raydium CPMM swap decoder (synthetic, offline)", () => {
  it("C-00: literal layouts match the pinned source encodings", () => {
    expect(CPMM_SWAP_BASE_INPUT_DISCRIMINATOR).toEqual(sha8("global:swap_base_input"));
    expect(CPMM_SWAP_BASE_OUTPUT_DISCRIMINATOR).toEqual(sha8("global:swap_base_output"));
    expect(CPMM_SWAP_EVENT_DISCRIMINATOR).toEqual(sha8("event:SwapEvent"));
    expect(swapData("IN", 1_000_000_000n, 2_400_000n).toString("hex")).toBe(
      "8fbe5adac41e33de" + "00ca9a3b00000000" + "009f240000000000",
    );
    expect(swapData("OUT", 5n, 6n).toString("hex")).toBe(
      "37d96256a34ab4ad" + "0500000000000000" + "0600000000000000",
    );
    expect(transferCheckedData(0x0102030405060708n, 9).toString("hex")).toBe(
      "0c" + "0807060504030201" + "09",
    );
    const ev = swapEventBytes({
      pool: FIXTURE_CPMM_POOL_ADDRESS,
      inputAmount: 1n,
      outputAmount: 2n,
      baseInput: true,
      inputMint: WSOL_MINT,
      outputMint: CANDIDATE_A,
    });
    expect(ev.length).toBe(170);
    expect(ev.subarray(56, 64).toString("hex")).toBe("0100000000000000");
    expect(ev[88]).toBe(1);
    // Adapter-produced pool contexts (both orientations).
    expect(POOL_A).toMatchObject({ orientation: "TOKEN_0_BASE_WSOL_QUOTE", baseDecimals: 6 });
    expect(POOL_B).toMatchObject({ orientation: "TOKEN_1_BASE_WSOL_QUOTE", baseDecimals: 6 });
    expect(POOL_A.baseVaultAddress).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
    expect(POOL_B.baseVaultAddress).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
  });

  it("C-01: a top-level swap decodes into one frozen TradeEvent from its transfers", () => {
    const r = expectDecoded(decode(simpleBuy()));
    const e = r.events[0]!;
    expect(e).toEqual({
      eventId: `${signatureOf(1)}:0:0`,
      signature: signatureOf(1),
      swapIndex: 0,
      outerInstructionIndex: 0,
      poolId: FIXTURE_CPMM_POOL_ADDRESS,
      tokenMint: CANDIDATE_A,
      side: "BUY",
      slot: 312_000_000,
      blockTimeSec: 1_794_829_420,
      eventTimestampMs: 1_794_829_420_000,
      receiptTimestampMs: 1_794_829_421_500,
      timestampProvenance: "ON_CHAIN_BLOCK_TIME",
      tokenAmount: 2_500_000n,
      solAmount: 1_000_000_000n,
    });
    expect(r.diagnostics).toEqual({
      topLevelInstructions: 1,
      innerInstructions: 2,
      cpmmInvocations: 1,
      targetSwaps: 1,
      nonTargetSwaps: 0,
      otherCpmmInstructions: 0,
      logCorroboration: "CORROBORATED",
      shortcut: null,
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.events)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(r.diagnostics)).toBe(true);
    // The existing tracker ingests the event unchanged, and deduplicates it.
    const tracker = new RollingTradeFlowTracker({
      poolId: FIXTURE_CPMM_POOL_ADDRESS,
      tokenMint: CANDIDATE_A,
      trackingStartedMs: 1_794_829_400_000,
      clock: () => 1_794_829_422_000,
    });
    const first = tracker.ingestTrade(e);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(tracker.ingestTrade(e).ok).toBe(false);
  });

  it("C-02 (T10): both orientations, BUY and SELL, map amounts to the candidate side", () => {
    for (const pool of [POOL_A, POOL_B]) {
      const buy = expectDecoded(
        decode(build({ signers: [PAYER], top: [swapIx({ pool, side: "BUY" })] }), pool),
      ).events[0]!;
      expect(buy).toMatchObject({
        side: "BUY",
        tokenMint: pool.candidateMint,
        solAmount: 1_000_000_000n,
        tokenAmount: 2_500_000n,
      });
      const sell = expectDecoded(
        decode(build({ signers: [PAYER], top: [swapIx({ pool, side: "SELL" })] }), pool),
      ).events[0]!;
      expect(sell).toMatchObject({
        side: "SELL",
        tokenAmount: 2_500_000n,
        solAmount: 900_000_000n,
      });
    }
    // Pool contexts must be the adapter's: decimals 0..18 accepted, 19 refused.
    for (const d of [0, 18]) {
      const pool = adaptedPool("A", d);
      const p = build({ signers: [PAYER], top: [swapIx({ pool, side: "SELL" })] });
      expect(expectDecoded(decode(p, pool)).events[0]!.tokenAmount).toBe(2_500_000n);
    }
    for (const bad of [
      { baseDecimals: 19 },
      { baseDecimals: -1 },
      { baseDecimals: 6.5 },
      { quoteDecimals: 8 },
      { orientation: "TOKEN_X" },
      { wsolMint: CANDIDATE_B },
      { candidateMint: WSOL_MINT },
      { quoteVaultAddress: POOL_A.baseVaultAddress },
      { poolAddress: "not-a-key" },
      { ok: false },
      { verification: { ...POOL_A.verification, authBumpVerified: false } },
    ]) {
      expectRefused(
        decode(simpleBuy(), { ...POOL_A, ...bad } as unknown as RaydiumCpmmPoolStateSuccess),
        "INVALID_POOL_CONTEXT",
      );
    }
  });

  it("C-03 (T1): timestamps come only from an integer blockTime; receipt time is injected", () => {
    for (const bt of [undefined, null]) {
      const p = simpleBuy();
      if (bt === undefined) delete p.blockTime;
      else p.blockTime = null;
      expectRefused(decode(p), "MISSING_UPSTREAM_TIMESTAMP");
    }
    for (const bt of [0, -1, 1.5, NaN, Infinity, "1794829420", MAX_BLOCK_TIME_SEC + 1]) {
      expectRefused(decode(simpleBuy({ blockTime: bt })), "INVALID_UPSTREAM_TIMESTAMP");
    }
    const edge = expectDecoded(decode(simpleBuy({ blockTime: MAX_BLOCK_TIME_SEC }))).events[0]!;
    expect(edge.eventTimestampMs).toBe(MAX_BLOCK_TIME_SEC * 1000);
    expect(Number.isSafeInteger(edge.eventTimestampMs)).toBe(true);
    for (const t of [undefined, 0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expectRefused(
        decode(simpleBuy(), POOL_A, { receiptTimestampMs: t }),
        "INVALID_RECEIPT_TIMESTAMP",
      );
    }
    expectRefused(
      decodeRaydiumCpmmTransactionSwaps(
        simpleBuy(),
        POOL_A,
        undefined as unknown as typeof RECEIPT,
      ),
      "INVALID_OPTIONS",
    );
    for (const extra of [{ fallbackProvenance: "HOST_OBSERVED" }, { clock: () => 1 }]) {
      expectRefused(decode(simpleBuy(), POOL_A, { ...RECEIPT, ...extra }), "INVALID_OPTIONS");
    }
    // No clock: a throwing Date.now is never reached.
    const realNow = Date.now;
    Date.now = () => {
      throw new Error("clock used");
    };
    try {
      expect(decode(simpleBuy()).status).toBe("SWAP_DECODED");
    } finally {
      Date.now = realNow;
    }
    // No events, no block time needed.
    const none = build({
      signers: [PAYER],
      top: [{ program: MEMO, accounts: [PAYER], data: Uint8Array.from([1]) }],
      blockTime: null,
    });
    expect(decode(none).status).toBe("NO_MATCHING_SWAPS");
  });

  it("C-04 (T2): envelope, encoding, version and account resolution", () => {
    const p = () => simpleBuy();
    const cases: [string, (x: Loose) => void, string][] = [
      ["version missing", (x) => delete x.version, "UNSUPPORTED_TRANSACTION_VERSION"],
      ["version 1", (x) => (x.version = 1), "UNSUPPORTED_TRANSACTION_VERSION"],
      ["version 2", (x) => (x.version = 2), "UNSUPPORTED_TRANSACTION_VERSION"],
      ["version '0'", (x) => (x.version = "0"), "UNSUPPORTED_TRANSACTION_VERSION"],
      [
        "jsonParsed keys",
        (x) =>
          (x.transaction.message.accountKeys = x.transaction.message.accountKeys.map(
            (k: string) => ({ pubkey: k, signer: false, writable: true }),
          )),
        "UNSUPPORTED_ENCODING",
      ],
      [
        "programId form",
        (x) => (x.transaction.message.instructions[0].programId = RAYDIUM_CPMM_PROGRAM_ID),
        "UNSUPPORTED_ENCODING",
      ],
      [
        "parsed form",
        (x) => (x.transaction.message.instructions[0].parsed = {}),
        "UNSUPPORTED_ENCODING",
      ],
      [
        "data as bytes",
        (x) => (x.transaction.message.instructions[0].data = [1, 2, 3]),
        "UNSUPPORTED_ENCODING",
      ],
      [
        "legacy with loaded addresses",
        (x) => (x.meta.loadedAddresses.writable = [key(50)]),
        "MALFORMED_ACCOUNT_KEYS",
      ],
      [
        "legacy with lookups",
        (x) => (x.transaction.message.addressTableLookups = []),
        "MALFORMED_ACCOUNT_KEYS",
      ],
      [
        "duplicate key",
        (x) => x.transaction.message.accountKeys.push(x.transaction.message.accountKeys[1]),
        "MALFORMED_ACCOUNT_KEYS",
      ],
      [
        "non-canonical key",
        (x) => (x.transaction.message.accountKeys[2] = "not-a-key"),
        "MALFORMED_ACCOUNT_KEYS",
      ],
      [
        "null key (no compaction)",
        (x) => (x.transaction.message.accountKeys[2] = null),
        "UNSUPPORTED_ENCODING",
      ],
      ["header missing", (x) => delete x.transaction.message.header, "MALFORMED_ACCOUNT_KEYS"],
      [
        "header over keys",
        (x) => (x.transaction.message.header.numRequiredSignatures = 999),
        "MALFORMED_ACCOUNT_KEYS",
      ],
      [
        "signatures != header",
        (x) => x.transaction.signatures.push(signatureOf(9)),
        "INVALID_PAYLOAD",
      ],
      ["signature invalid", (x) => (x.transaction.signatures[0] = "abc"), "MISSING_SIGNATURE"],
      ["slot -1", (x) => (x.slot = -1), "INVALID_SLOT"],
      ["slot 1.5", (x) => (x.slot = 1.5), "INVALID_SLOT"],
      ["meta missing", (x) => delete x.meta, "METADATA_UNAVAILABLE"],
      ["meta.err absent", (x) => delete x.meta.err, "METADATA_UNAVAILABLE"],
    ];
    for (const [label, edit, reason] of cases) {
      const x = p();
      edit(x);
      const r = decode(x);
      expect((r as Loose).reason, label).toBe(reason);
      expectRefused(r, reason);
    }
    expectRefused(decode(null), "INVALID_PAYLOAD");
    expectRefused(decode("tx"), "INVALID_PAYLOAD");
    // v0 with lookup-table accounts resolves without compaction; length mismatches are refused.
    const v0 = build({
      signers: [PAYER],
      top: [swapIx({ side: "BUY" })],
      loaded: [USER_WSOL, USER_TOKEN],
    });
    expect(v0.version).toBe(0);
    expectDecoded(decode(v0));
    const mismatch = build({
      signers: [PAYER],
      top: [swapIx({ side: "BUY" })],
      loaded: [USER_WSOL, USER_TOKEN],
    });
    mismatch.transaction.message.addressTableLookups[0].writableIndexes.push(5);
    expectRefused(decode(mismatch), "MALFORMED_ACCOUNT_KEYS", "V0_LOADED");
    const noLookups = build({
      signers: [PAYER],
      top: [swapIx({ side: "BUY" })],
      loaded: [USER_WSOL],
    });
    delete noLookups.transaction.message.addressTableLookups;
    expectRefused(decode(noLookups), "MALFORMED_ACCOUNT_KEYS", "V0_LOOKUPS");
  });

  it("C-05: malformed account resolution is refused before the failure and not-referenced shortcuts", () => {
    // A failed transaction is TRANSACTION_FAILED only with a valid envelope and accounts.
    const failed = simpleBuy({ err: { InstructionError: [0, { Custom: 1 }] } });
    expect(decode(failed)).toEqual({
      ok: false,
      status: "TRANSACTION_FAILED",
      signature: signatureOf(1),
      slot: 312_000_000,
      events: [],
    });
    const failedBadKeys = simpleBuy({ err: { InstructionError: [0, "Custom"] } });
    failedBadKeys.transaction.message.accountKeys.push(
      failedBadKeys.transaction.message.accountKeys[0],
    );
    expectRefused(decode(failedBadKeys), "MALFORMED_ACCOUNT_KEYS");
    const failedBadIx = simpleBuy({ err: "X" });
    failedBadIx.transaction.message.instructions[0].programIdIndex = 999;
    expectRefused(decode(failedBadIx), "MALFORMED_INSTRUCTION_DATA");
    const failedV1 = simpleBuy({ err: "X", version: 1 });
    expectRefused(decode(failedV1), "UNSUPPORTED_TRANSACTION_VERSION");
    // The not-referenced shortcut needs valid accounts, instructions, inner groups and logs.
    const memoOnly = (extra: Partial<TxSpec> = {}) =>
      build({
        signers: [PAYER],
        top: [{ program: MEMO, accounts: [PAYER], data: Uint8Array.from([1]) }],
        ...extra,
      });
    expect(decode(memoOnly())).toMatchObject({
      status: "NO_MATCHING_SWAPS",
      diagnostics: { shortcut: "TARGET_POOL_NOT_REFERENCED", logCorroboration: "NOT_EVALUATED" },
    });
    expect(decode(memoOnly({ innerNull: true, logs: "NONE" }))).toMatchObject({
      status: "NO_MATCHING_SWAPS",
      diagnostics: { shortcut: "TARGET_POOL_NOT_REFERENCED", logCorroboration: "UNAVAILABLE" },
    });
    const dupKey = memoOnly();
    dupKey.transaction.message.accountKeys.push(MEMO);
    expectRefused(decode(dupKey), "MALFORMED_ACCOUNT_KEYS");
    const badKey = memoOnly();
    badKey.transaction.message.accountKeys[1] = "x".repeat(40);
    expectRefused(decode(badKey), "MALFORMED_ACCOUNT_KEYS");
    const badInner = memoOnly();
    badInner.meta.innerInstructions = [
      { index: 0, instructions: [{ programIdIndex: 0, accounts: [], data: "", stackHeight: 7 }] },
    ];
    expectRefused(decode(badInner), "UNSUPPORTED_CALL_TREE");
    const failedLog = memoOnly({
      logs: [`Program ${MEMO} invoke [1]`, `Program ${MEMO} failed: oops`],
    });
    expectRefused(
      decode(failedLog),
      "CONFLICTING_EVIDENCE",
      "FAILED_LOG_IN_SUCCESSFUL_TRANSACTION",
    );
  });

  it("C-06 (T3): a recorded runtime failure contradicts meta.err === null, whatever the log state", () => {
    const base = simpleBuy();
    const logs: string[] = base.meta.logMessages;
    const failLine = `Program ${SPL_TOKEN_PROGRAM_ID} failed: custom program error: 0x1`;
    const variants: [string, string[]][] = [
      ["complete", [...logs.slice(0, -1), failLine]],
      ["truncated", [...logs.slice(0, 3), failLine, "Log truncated"]],
      ["unbalanced", [logs[0]!, failLine]],
      ["failure without detail", [...logs, `Program ${RAYDIUM_CPMM_PROGRAM_ID} failed`]],
    ];
    for (const [label, l] of variants) {
      const p = simpleBuy({ logs: l });
      const r = decode(p);
      expectRefused(r, "CONFLICTING_EVIDENCE", "FAILED_LOG_IN_SUCCESSFUL_TRANSACTION");
      void label;
    }
    // Routed swap without logs: meta.err === null is the proof of completion.
    const routed = build({
      signers: [PAYER],
      top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
      logs: "NONE",
    });
    const r = expectDecoded(decode(routed));
    expect(r.diagnostics.logCorroboration).toBe("UNAVAILABLE");
  });

  it("C-07 (T4): inner groups and stack heights", () => {
    expectRefused(decode(simpleBuy({ innerNull: true })), "INNER_INSTRUCTIONS_UNAVAILABLE");
    const noInner = simpleBuy();
    delete noInner.meta.innerInstructions;
    expectRefused(decode(noInner), "INNER_INSTRUCTIONS_UNAVAILABLE");
    for (const [label, edit] of [
      [
        "duplicate index",
        (x: Loose) => x.meta.innerInstructions.push({ ...x.meta.innerInstructions[0] }),
      ],
      ["index out of range", (x: Loose) => (x.meta.innerInstructions[0].index = 5)],
      ["empty group", (x: Loose) => (x.meta.innerInstructions[0].instructions = [])],
    ] as const) {
      const x = simpleBuy();
      edit(x);
      expectRefused(decode(x), "UNSUPPORTED_CALL_TREE", "GROUP");
      void label;
    }
    for (const sh of [undefined, null, 0, 1, 10, 2.5, "2"]) {
      const x = editIx(simpleBuy(), 0, 2, (ix) => {
        if (sh === undefined) delete ix.stackHeight;
        else ix.stackHeight = sh;
      });
      expectRefused(decode(x), "UNSUPPORTED_CALL_TREE");
    }
    // A missing height far from the pool still refuses (boundaries are never inferred).
    const far = build({
      signers: [PAYER],
      top: [
        swapIx({ side: "BUY" }),
        router([{ program: MEMO, accounts: [PAYER], data: Uint8Array.from([0]) }]),
      ],
    });
    editIx(far, 1, 1, (ix) => delete ix.stackHeight);
    expectRefused(decode(far), "UNSUPPORTED_CALL_TREE");
    // Height skip 2 -> 4.
    expectRefused(
      decode(editIx(simpleBuy(), 0, 1, (ix) => (ix.stackHeight = 3))),
      "UNSUPPORTED_CALL_TREE",
    );
    // Top-level stackHeight must be 1 or null.
    expectRefused(
      decode(editIx(simpleBuy(), 0, 0, (ix) => (ix.stackHeight = 2))),
      "UNSUPPORTED_CALL_TREE",
    );
    expectDecoded(decode(editIx(simpleBuy(), 0, 0, (ix) => (ix.stackHeight = 1))));
  });

  it("C-08 (T4): pure-decoder bounds are enforced before expensive decoding", () => {
    const L = CPMM_DECODER_LIMITS;
    expect(L).toEqual({
      maxAccountKeys: 256,
      maxTopLevelInstructions: 64,
      maxInnerInstructions: 1_024,
      maxInstructionAccounts: 256,
      maxInstructionDataChars: 14_000,
      maxInstructionDataBytes: 10_240,
      maxLogLines: 10_000,
      maxLogBytes: 1_048_576,
      maxStackHeight: 9,
    });
    const tooManyKeys = simpleBuy();
    for (let i = 0; i < 250; i++)
      tooManyKeys.transaction.message.accountKeys.push(key(100 + (i % 150)));
    expectRefused(decode(tooManyKeys), "EVIDENCE_LIMIT_EXCEEDED", "ACCOUNT_KEYS");
    const tooManyTop = simpleBuy();
    for (let i = 0; i < 64; i++)
      tooManyTop.transaction.message.instructions.push({
        programIdIndex: 0,
        accounts: [],
        data: "",
      });
    expectRefused(decode(tooManyTop), "EVIDENCE_LIMIT_EXCEEDED", "TOP_LEVEL");
    const tooManyInner = simpleBuy();
    const g = tooManyInner.meta.innerInstructions[0];
    while (g.instructions.length <= 1024) g.instructions.push({ ...g.instructions[1] });
    expectRefused(decode(tooManyInner), "EVIDENCE_LIMIT_EXCEEDED", "INNER");
    // Encoded length is checked before base58 decoding; then decoded bytes.
    // The encoded length is refused before base58 decoding: the invalid final character is
    // never reached (decoding it would report MALFORMED_INSTRUCTION_DATA instead).
    const longChars = editIx(simpleBuy(), 0, 0, (ix) => (ix.data = "z".repeat(14_000) + "0"));
    const started = performance.now();
    expectRefused(decode(longChars), "EVIDENCE_LIMIT_EXCEEDED", "instruction 0");
    expect(performance.now() - started).toBeLessThan(1_000);
    // At exactly 14,000 characters the string is decoded (and refused as malformed here).
    expectRefused(
      decode(editIx(simpleBuy(), 0, 0, (ix) => (ix.data = "z".repeat(13_999) + "0"))),
      "MALFORMED_INSTRUCTION_DATA",
    );
    const tenKiB = encodeBase58(new Uint8Array(10_241).fill(0xee));
    expect(tenKiB.length).toBeLessThanOrEqual(14_000);
    expectRefused(
      decode(editIx(simpleBuy(), 0, 0, (ix) => (ix.data = tenKiB))),
      "EVIDENCE_LIMIT_EXCEEDED",
    );
    // Exactly 10,240 decoded bytes passes the bound (then fails as a non-swap CPMM instruction).
    expectRefused(
      decode(
        editIx(simpleBuy(), 0, 0, (ix) => (ix.data = encodeBase58(new Uint8Array(10_240).fill(1)))),
      ),
      "UNSUPPORTED_INSTRUCTION",
    );
    const manyAccounts = editIx(simpleBuy(), 0, 0, (ix) => {
      ix.accounts = Array.from({ length: 257 }, () => 0);
    });
    expectRefused(decode(manyAccounts), "EVIDENCE_LIMIT_EXCEEDED");
    expectRefused(
      decode(simpleBuy({ logs: Array.from({ length: 10_001 }, () => "Program log: x") })),
      "EVIDENCE_LIMIT_EXCEEDED",
      "LOG_LINES",
    );
    expectRefused(
      decode(simpleBuy({ logs: ["Program log: " + "x".repeat(1_048_576)] })),
      "EVIDENCE_LIMIT_EXCEEDED",
      "LOG_BYTES",
    );
    expectRefused(decode(simpleBuy({ logs: [5 as unknown as string] })), "INVALID_PAYLOAD", "LOGS");
  });

  it("C-09 (T5): the swap frame must have exactly two direct-child transfers", () => {
    // Last inner entry with no descendants (the withdrawn "final inner instruction" case).
    const noKids = build({
      signers: [PAYER],
      top: [router([{ ...swapIx({ side: "BUY", payer: ROUTER_PDA }), children: [] }])],
    });
    expectRefused(decode(noKids), "CONFLICTING_EVIDENCE", "SWAP_FRAME_SHAPE_INVALID");
    const swap = swapIx({ side: "BUY" });
    const memoChild: Ix = { program: MEMO, accounts: [PAYER], data: Uint8Array.from([9]) };
    const shapes: [string, Ix[]][] = [
      ["one child", [swap.children![0]!]],
      ["three children", [...swap.children!, swap.children![1]!]],
      ["grandchild", [{ ...swap.children![0]!, children: [memoChild] }, swap.children![1]!]],
      ["order swapped", [swap.children![1]!, swap.children![0]!]],
      ["memo child", [swap.children![0]!, memoChild]],
      ["cpmm child", [swap.children![0]!, { ...swapIx({ side: "BUY" }), children: [] }]],
    ];
    for (const [label, children] of shapes) {
      const r = decode(build({ signers: [PAYER], top: [{ ...swap, children }] }));
      expect(r.status, label).toBe("UNRESOLVED_EVIDENCE");
      expect((r as Loose).reason, label).toBe("CONFLICTING_EVIDENCE");
    }
  });

  it("C-10 (T5/T8): routed swaps, PDA payers, siblings, repeated program IDs and depth", () => {
    // Router -> CPMM (2) -> transfers (3); the payer is the router's PDA, not a signer.
    const routed = build({
      signers: [PAYER],
      top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
    });
    expect(indexOf(routed, ROUTER_PDA)).toBeGreaterThanOrEqual(1);
    const r1 = expectDecoded(decode(routed));
    expect(r1.events[0]).toMatchObject({
      outerInstructionIndex: 0,
      swapIndex: 1,
      eventId: `${signatureOf(1)}:0:1`,
    });
    // The PDA payer may even come from a lookup table (lookup tables cannot load signers).
    expectDecoded(
      decode(
        build({
          signers: [PAYER],
          top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
          loaded: [ROUTER_PDA],
        }),
      ),
    );
    // A routed swap whose payer is a transaction signer is accepted too.
    expectDecoded(decode(build({ signers: [PAYER], top: [router([swapIx({ side: "BUY" })])] })));
    // Two sibling target swaps with a router transfer between them.
    const routerTransfer: Ix = {
      program: SPL_TOKEN_PROGRAM_ID,
      accounts: [USER_WSOL, WSOL_MINT, POOL_A.quoteVaultAddress, ROUTER_PDA],
      data: transferCheckedData(1_000_000_000n, 9),
    };
    const siblings = build({
      signers: [PAYER],
      top: [
        router([
          swapIx({ side: "BUY", payer: ROUTER_PDA }),
          routerTransfer,
          swapIx({ side: "SELL", payer: ROUTER_PDA }),
        ]),
      ],
    });
    const r2 = expectDecoded(decode(siblings), 2);
    expect(r2.events.map((e) => [e.side, e.swapIndex])).toEqual([
      ["BUY", 1],
      ["SELL", 5],
    ]);
    expect(new Set(r2.events.map((e) => e.eventId)).size).toBe(2);
    // A top-level and a routed target swap in one transaction, in execution order.
    const mixed = build({
      signers: [PAYER],
      top: [swapIx({ side: "SELL" }), router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
    });
    const r3 = expectDecoded(decode(mixed), 2);
    expect(r3.events.map((e) => e.eventId)).toEqual([
      `${signatureOf(1)}:0:0`,
      `${signatureOf(1)}:1:1`,
    ]);
    // Deep nesting: swap at height 4 (transfers at 5) and at height 8 (transfers at 9).
    const nest = (depth: number, inner: Ix): Ix =>
      depth === 0 ? inner : router([nest(depth - 1, inner)]);
    expectDecoded(
      decode(
        build({ signers: [PAYER], top: [nest(3, swapIx({ side: "BUY", payer: ROUTER_PDA }))] }),
      ),
    );
    expectDecoded(
      decode(
        build({ signers: [PAYER], top: [nest(7, swapIx({ side: "BUY", payer: ROUTER_PDA }))] }),
      ),
    );
    expectRefused(
      decode(
        build({ signers: [PAYER], top: [nest(8, swapIx({ side: "BUY", payer: ROUTER_PDA }))] }),
      ),
      "UNSUPPORTED_CALL_TREE",
    );
    // Top-level payer must be a message signer; signer 1 (not the fee payer) is fine.
    const notSigner = build({ signers: [SIGNER_2], top: [swapIx({ side: "BUY" })] });
    expectRefused(decode(notSigner), "CONFLICTING_EVIDENCE", "PAYER_NOT_MESSAGE_SIGNER");
    const secondSigner = build({ signers: [SIGNER_2, PAYER], top: [swapIx({ side: "BUY" })] });
    expect(indexOf(secondSigner, PAYER)).toBe(1);
    expectDecoded(decode(secondSigner));
  });

  it("C-11 (T6): TransferChecked binding is exact; no plain Transfer fallback", () => {
    const child = (pos: 1 | 2, edit: (ix: Loose, p: Loose) => void) => {
      const p = simpleBuy({ logs: "NONE" });
      editIx(p, 0, pos, (ix) => edit(ix, p));
      return decode(p);
    };
    const tag3 = Buffer.concat([Buffer.from([3]), u64(1_000_000_000n)]);
    const cases: [string, 1 | 2, (ix: Loose, p: Loose) => void][] = [
      ["plain Transfer tag 3", 1, (ix) => (ix.data = encodeBase58(tag3))],
      [
        "9-byte data",
        1,
        (ix) => (ix.data = encodeBase58(transferCheckedData(1_000_000_000n, 9).subarray(0, 9))),
      ],
      [
        "11-byte data",
        1,
        (ix) =>
          (ix.data = encodeBase58(
            Buffer.concat([transferCheckedData(1_000_000_000n, 9), Buffer.from([0])]),
          )),
      ],
      ["3 accounts", 1, (ix) => ix.accounts.pop()],
      ["5 accounts (multisig)", 2, (ix) => ix.accounts.push(ix.accounts[0])],
      [
        "source swapped",
        1,
        (ix) => ([ix.accounts[0], ix.accounts[2]] = [ix.accounts[2], ix.accounts[0]]),
      ],
      ["source substituted", 1, (ix, p) => (ix.accounts[0] = indexOf(p, USER_TOKEN))],
      ["destination substituted", 2, (ix, p) => (ix.accounts[2] = indexOf(p, USER_WSOL))],
      ["wrong mint", 2, (ix, p) => (ix.accounts[1] = indexOf(p, WSOL_MINT))],
      ["out authority = payer", 2, (ix, p) => (ix.accounts[3] = indexOf(p, PAYER))],
      ["in authority = PDA", 1, (ix, p) => (ix.accounts[3] = indexOf(p, RAYDIUM_CPMM_AUTHORITY))],
      [
        "decimals mismatch",
        1,
        (ix) => (ix.data = encodeBase58(transferCheckedData(1_000_000_000n, 6))),
      ],
      ["zero amount", 2, (ix) => (ix.data = encodeBase58(transferCheckedData(0n, 6)))],
      ["child program not SPL Token", 1, (ix, p) => (ix.programIdIndex = indexOf(p, MEMO))],
    ];
    for (const [label, pos, edit] of cases) {
      const r = child(pos, (ix, p) => {
        if (label === "child program not SPL Token") p.transaction.message.accountKeys.push(MEMO);
        edit(ix, p);
      });
      expect(r.status, label).toBe("UNRESOLVED_EVIDENCE");
      expect((r as Loose).detail, label).toBe("TRANSFER_BINDING_INVALID");
    }
    // Token-2022 as the swap's token program.
    const t22 = simpleBuy();
    t22.transaction.message.accountKeys.push(TOKEN_2022_PROGRAM_ID);
    editIx(t22, 0, 0, (ix) => (ix.accounts[8] = indexOf(t22, TOKEN_2022_PROGRAM_ID)));
    expectRefused(decode(t22), "UNSUPPORTED_TOKEN_PROGRAM");
  });

  it("C-12 (T7): exact executed quantities and parameter consistency", () => {
    const max = 2n ** 64n - 1n;
    const big = expectDecoded(
      decode(simpleBuy({}, { inAmount: max, outAmount: max, p1: max, p2: max })),
    ).events[0]!;
    expect(big.solAmount).toBe(max);
    expect(big.tokenAmount).toBe(max);
    expect(typeof big.solAmount).toBe("bigint");
    const cases: [string, Partial<SwapSpec>, string][] = [
      ["in != amount_in", { kind: "IN", p1: 999_999_999n }, "AMOUNT_PARAMETER_MISMATCH"],
      ["out < minimum", { kind: "IN", p2: 2_500_001n }, "AMOUNT_PARAMETER_MISMATCH"],
      ["out != amount_out", { kind: "OUT", p2: 2_499_999n }, "AMOUNT_PARAMETER_MISMATCH"],
      ["in > max_in", { kind: "OUT", p1: 999_999_999n }, "AMOUNT_PARAMETER_MISMATCH"],
    ];
    for (const [label, s, detail] of cases) {
      expectRefused(decode(simpleBuy({ logs: "NONE" }, s)), "CONFLICTING_EVIDENCE", detail);
      void label;
    }
    expectDecoded(decode(simpleBuy({}, { kind: "IN", p2: 2_500_000n })));
    expectDecoded(decode(simpleBuy({}, { kind: "OUT", p1: 1_000_000_000n })));
    // The parameters are never the recorded amounts.
    const r = expectDecoded(decode(simpleBuy({}, { kind: "OUT", p1: 5_000_000_000n })));
    expect(r.events[0]!.solAmount).toBe(1_000_000_000n);
  });

  it("C-13 (T9): identity, vault and mint binding; unrelated and non-target instructions", () => {
    const edit = (f: (ix: Loose, p: Loose) => void) => {
      const p = simpleBuy({ logs: "NONE" });
      editIx(p, 0, 0, (ix) => f(ix, p));
      return decode(p);
    };
    expectRefused(
      edit((ix) => ix.accounts.pop()),
      "MALFORMED_INSTRUCTION_DATA",
    );
    expectRefused(
      edit((ix) => ix.accounts.push(0)),
      "UNSUPPORTED_ACCOUNT_COUNT",
    );
    expectRefused(
      edit((ix) => (ix.data = encodeBase58(swapData("IN", 1n, 1n).subarray(0, 23)))),
      "MALFORMED_INSTRUCTION_DATA",
    );
    expectRefused(
      edit((ix, p) => (ix.accounts[1] = indexOf(p, AMM_CONFIG))),
      "IDENTITY_MISMATCH",
    );
    expectRefused(
      edit((ix, p) => (ix.accounts[8] = indexOf(p, AMM_CONFIG))),
      "IDENTITY_MISMATCH",
    );
    expectRefused(
      edit((ix) => (ix.accounts[7] = ix.accounts[6])),
      "VAULT_MISMATCH",
    );
    expectRefused(
      edit((ix, p) => (ix.accounts[6] = indexOf(p, USER_TOKEN))),
      "VAULT_MISMATCH",
    );
    expectRefused(
      edit((ix, p) => (ix.accounts[10] = indexOf(p, CANDIDATE_A))),
      "MINT_MISMATCH",
    );
    expectRefused(
      edit((ix) => (ix.accounts[5] = ix.accounts[4])),
      "CONFLICTING_EVIDENCE",
      "USER_ACCOUNT_INVALID",
    );
    expectRefused(
      edit((ix) => (ix.accounts[4] = ix.accounts[7])),
      "CONFLICTING_EVIDENCE",
    );
    // Another pool's swap: counted and ignored, unless it references the target.
    const other: Ix = {
      ...swapIx({ side: "BUY" }),
      accounts: swapIx({ side: "BUY" }).accounts.map((a) =>
        a === FIXTURE_CPMM_POOL_ADDRESS
          ? OTHER_POOL
          : a === POOL_A.quoteVaultAddress
            ? OTHER_VAULT_0
            : a === POOL_A.baseVaultAddress
              ? OTHER_VAULT_1
              : a,
      ),
    };
    const onlyOther = build({
      signers: [PAYER],
      top: [
        other,
        { program: MEMO, accounts: [FIXTURE_CPMM_POOL_ADDRESS], data: Uint8Array.from([0]) },
      ],
    });
    expect(decode(onlyOther)).toMatchObject({
      status: "NO_MATCHING_SWAPS",
      diagnostics: { nonTargetSwaps: 1, targetSwaps: 0, shortcut: null },
    });
    const otherTouching = build({
      signers: [PAYER],
      top: [
        {
          ...other,
          accounts: other.accounts.map((a) => (a === OTHER_VAULT_1 ? POOL_A.baseVaultAddress : a)),
        },
      ],
    });
    expectRefused(decode(otherTouching), "IDENTITY_MISMATCH");
    // A target vault referenced without the pool is not covered by the shortcut.
    const vaultOnly = build({
      signers: [PAYER],
      top: [{ program: MEMO, accounts: [POOL_A.baseVaultAddress], data: Uint8Array.from([0]) }],
    });
    expect(decode(vaultOnly)).toMatchObject({
      status: "NO_MATCHING_SWAPS",
      diagnostics: { shortcut: null },
    });
    vaultOnly.meta.innerInstructions = null;
    expectRefused(decode(vaultOnly), "INNER_INSTRUCTIONS_UNAVAILABLE");
    // Non-swap CPMM instructions: refused on the target pool, ignored elsewhere.
    const deposit = (pool: string): Ix => ({
      program: RAYDIUM_CPMM_PROGRAM_ID,
      accounts: [PAYER, RAYDIUM_CPMM_AUTHORITY, pool],
      data: Uint8Array.from([...sha8("global:deposit"), 1, 2, 3]),
    });
    expectRefused(
      decode(build({ signers: [PAYER], top: [deposit(FIXTURE_CPMM_POOL_ADDRESS)] })),
      "UNSUPPORTED_INSTRUCTION",
    );
    expect(
      decode(build({ signers: [PAYER], top: [deposit(OTHER_POOL), swapIx({ side: "BUY" })] })),
    ).toMatchObject({ status: "SWAP_DECODED", diagnostics: { otherCpmmInstructions: 1 } });
    expectRefused(
      decode(
        build({
          signers: [PAYER],
          top: [
            {
              program: RAYDIUM_CPMM_PROGRAM_ID,
              accounts: [FIXTURE_CPMM_POOL_ADDRESS],
              data: Uint8Array.from([1, 2]),
            },
          ],
        }),
      ),
      "MALFORMED_INSTRUCTION_DATA",
    );
    // A malformed unrelated instruction anywhere refuses the transaction.
    const unrelated = build({
      signers: [PAYER],
      top: [
        swapIx({ side: "BUY" }),
        { program: MEMO, accounts: [PAYER], data: Uint8Array.from([1]) },
      ],
    });
    expectRefused(
      decode(editIx(unrelated, 1, 0, (ix) => (ix.data = "0OIl"))),
      "MALFORMED_INSTRUCTION_DATA",
    );
    expectRefused(
      decode(editIx(unrelated, 1, 0, (ix) => (ix.accounts = [9999]))),
      "MALFORMED_INSTRUCTION_DATA",
    );
    expectRefused(
      decode(editIx(unrelated, 1, 0, (ix) => (ix.programIdIndex = -1))),
      "MALFORMED_INSTRUCTION_DATA",
    );
    // Unrelated transfers outside the swap subtree are ignored.
    const outside: Ix = {
      program: SPL_TOKEN_PROGRAM_ID,
      accounts: [USER_WSOL, WSOL_MINT, POOL_A.quoteVaultAddress, PAYER],
      data: transferCheckedData(777n, 9),
    };
    const r = expectDecoded(
      decode(build({ signers: [PAYER], top: [outside, swapIx({ side: "BUY" })] })),
    );
    expect(r.events[0]!.solAmount).toBe(1_000_000_000n);
  });

  it("C-14 (T11): logs corroborate or contradict, never establish", () => {
    expect(decode(simpleBuy()).status).toBe("SWAP_DECODED");
    const ev = (over: Partial<EventFields> | string[]) => decode(simpleBuy({}, { event: over }));
    const mismatches: [string, Partial<EventFields> | string[]][] = [
      ["input amount", { inputAmount: 1n }],
      ["output amount", { outputAmount: 1n }],
      ["pool", { pool: OTHER_POOL }],
      ["input mint", { inputMint: CANDIDATE_A }],
      ["base_input", { baseInput: false }],
      ["input fee", { inFee: 1n }],
      ["output fee", { outFee: 1n }],
      ["bool byte 2", { boolByte: 2 }],
      [
        "two events",
        [
          swapEventBytes({
            pool: FIXTURE_CPMM_POOL_ADDRESS,
            inputAmount: 1_000_000_000n,
            outputAmount: 2_500_000n,
            baseInput: true,
            inputMint: WSOL_MINT,
            outputMint: CANDIDATE_A,
          }).toString("base64"),
          "AA==",
        ],
      ],
      ["no event", []],
      ["169 bytes", [Buffer.alloc(169).toString("base64")]],
      ["not base64", ["@@@"]],
    ];
    for (const [label, over] of mismatches) {
      const r = ev(over);
      expect(r.status, label).toBe("UNRESOLVED_EVIDENCE");
      expect((r as Loose).detail, label).toBe("EVENT_MISMATCH");
    }
    // An event logged only inside a child frame does not count for the swap frame.
    const p = simpleBuy({}, { event: [] });
    const b64 = swapEventBytes({
      pool: FIXTURE_CPMM_POOL_ADDRESS,
      inputAmount: 1_000_000_000n,
      outputAmount: 2_500_000n,
      baseInput: true,
      inputMint: WSOL_MINT,
      outputMint: CANDIDATE_A,
    }).toString("base64");
    const logs: string[] = p.meta.logMessages;
    logs.splice(
      logs.indexOf(`Program ${SPL_TOKEN_PROGRAM_ID} invoke [2]`) + 1,
      0,
      `Program data: ${b64}`,
    );
    expectRefused(decode(p), "CONFLICTING_EVIDENCE", "EVENT_MISMATCH");
    // Trace mismatches.
    const extraCpmm = simpleBuy();
    extraCpmm.meta.logMessages.push(
      `Program ${RAYDIUM_CPMM_PROGRAM_ID} invoke [1]`,
      `Program ${RAYDIUM_CPMM_PROGRAM_ID} success`,
    );
    expectRefused(decode(extraCpmm), "CONFLICTING_EVIDENCE", "LOG_TRACE_MISMATCH");
    const routedLogs = build({
      signers: [PAYER],
      top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
    });
    routedLogs.meta.logMessages = routedLogs.meta.logMessages.map((l: string) =>
      l.startsWith(`Program ${SPL_TOKEN_PROGRAM_ID} invoke`)
        ? `Program ${MEMO} invoke [3]`
        : l.startsWith(`Program ${SPL_TOKEN_PROGRAM_ID} success`)
          ? `Program ${MEMO} success`
          : l,
    );
    expectRefused(decode(routedLogs), "CONFLICTING_EVIDENCE", "LOG_TRACE_MISMATCH");
    // Incomplete or absent logs: decoded from instructions, not corroborated.
    const truncated = simpleBuy();
    truncated.meta.logMessages = [...truncated.meta.logMessages.slice(0, 4), "Log truncated"];
    expect(decode(truncated)).toMatchObject({
      status: "SWAP_DECODED",
      diagnostics: { logCorroboration: "INCOMPLETE" },
    });
    const unbalanced = simpleBuy();
    unbalanced.meta.logMessages.pop();
    expect(decode(unbalanced)).toMatchObject({
      status: "SWAP_DECODED",
      diagnostics: { logCorroboration: "INCOMPLETE" },
    });
    const badEventButIncomplete = simpleBuy({}, { event: { inputAmount: 1n } });
    badEventButIncomplete.meta.logMessages.pop();
    expect(decode(badEventButIncomplete).status).toBe("SWAP_DECODED");
    expect(decode(simpleBuy({ logs: "NONE" }))).toMatchObject({
      status: "SWAP_DECODED",
      diagnostics: { logCorroboration: "UNAVAILABLE" },
    });
  });

  it("C-15 (T12): no partial results, stable identifiers, no input mutation", () => {
    // One valid target swap plus one invalid target swap: the whole transaction is refused.
    const bad = swapIx({ side: "SELL" });
    const partial = build({
      signers: [PAYER],
      top: [swapIx({ side: "BUY" }), { ...bad, children: [bad.children![0]!] }],
    });
    expectRefused(decode(partial), "CONFLICTING_EVIDENCE", "SWAP_FRAME_SHAPE_INVALID");
    // Identifiers do not depend on logs, other pools' swaps placed later, or the decoding pool.
    const base = build({
      signers: [PAYER],
      top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })])],
    });
    const ids = (p: Loose) => expectDecoded(decode(p)).events.map((e) => e.eventId);
    const withoutLogs = structuredClone(base);
    withoutLogs.meta.logMessages = null;
    expect(ids(withoutLogs)).toEqual(ids(base));
    const other: Ix = {
      ...swapIx({ side: "BUY" }),
      accounts: swapIx({ side: "BUY" }).accounts.map((a) =>
        a === FIXTURE_CPMM_POOL_ADDRESS
          ? OTHER_POOL
          : a === POOL_A.quoteVaultAddress
            ? OTHER_VAULT_0
            : a === POOL_A.baseVaultAddress
              ? OTHER_VAULT_1
              : a,
      ),
    };
    const appended = build({
      signers: [PAYER],
      top: [router([swapIx({ side: "BUY", payer: ROUTER_PDA })]), other],
    });
    expect(ids(appended)).toEqual(ids(base));
    // Decoding the same transaction twice gives identical results; input is not mutated.
    const frozen = structuredClone(base);
    const deepFreezeIn = (o: unknown) => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        Object.values(o).forEach(deepFreezeIn);
      }
    };
    deepFreezeIn(frozen);
    const before = JSON.stringify(frozen);
    const a = decode(frozen);
    const b = decode(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(a).toEqual(b);
    // TRANSACTION_FAILED carries no events and no pool claim.
    const f = decode(simpleBuy({ err: "X" }));
    expect(f).toEqual({
      ok: false,
      status: "TRANSACTION_FAILED",
      signature: signatureOf(1),
      slot: 312_000_000,
      events: [],
    });
    // A throwing getter becomes a refusal, never an exception.
    const hostile = simpleBuy();
    Object.defineProperty(hostile.meta, "innerInstructions", {
      get() {
        throw new Error("boom");
      },
    });
    expectRefused(decode(hostile), "INVALID_PAYLOAD");
  });
});

// ---------------------------------------------------------------------------------------------
// Solana transaction v1 (SIMD-0385): SYNTHETIC, specification-grounded fixtures
// ---------------------------------------------------------------------------------------------
//
// Every v1 payload below is SYNTHETIC: built in memory from the JSON shape Agave serializes for a
// v1 message (agave 318c00ca, transaction-status-client-types `UiRawMessage`: no
// `addressTableLookups`, a `transactionConfig` object of exactly four camelCase keys with unset
// values serialized as `null`; `version` serialized as the number 1 by the untagged
// `TransactionVersion`, solana-sdk 7b382f65) and the constraints of SIMD-0385 (6cc17538). None of
// it is observed mainnet evidence: the four version-1 exchanges of cpmm-observation-03 hold only
// JSON-RPC -32015 errors (no v1 transaction payload), and no relabelled v0 capture is used here.

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** SetComputeUnitLimit(200_000): a configuration no-op in a v1 transaction (SIMD-0385). */
const computeBudgetNoOp = (): Ix => ({
  program: COMPUTE_BUDGET,
  accounts: [],
  data: Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]),
});
const memoIx = (data: Uint8Array = Uint8Array.from([1]), accounts: string[] = []): Ix => ({
  program: MEMO,
  accounts,
  data,
});
const V1_CONFIG = Object.freeze({
  priorityFee: 5_000,
  computeUnitLimit: 200_000,
  loadedAccountsDataSizeLimit: 65_536,
  heapSize: null,
});
const NULL_CONFIG = Object.freeze({
  priorityFee: null,
  computeUnitLimit: null,
  loadedAccountsDataSizeLimit: null,
  heapSize: null,
});
const CAP1 = { ...RECEIPT, maxSupportedTransactionVersion: 1 } as const;
const CAP0 = { ...RECEIPT, maxSupportedTransactionVersion: 0 } as const;
/** A synthetic v1 response: the builder's static-only message, version 1, and a config. */
function v1Tx(spec: Partial<TxSpec> = {}, config: unknown = { ...V1_CONFIG }): Loose {
  const p = build({ signers: [PAYER], top: [swapIx({ side: "BUY" })], ...spec, version: 1 });
  p.transaction.message.transactionConfig = config;
  return p;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const decodeB58Length = (s: string): number => {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes++;
  }
  return bytes;
};
/** The SIMD-0385 serialized size of a synthetic v1 payload (an independent recomputation). */
function v1Bytes(p: Loose): number {
  const c = p.transaction.message.transactionConfig as Record<string, unknown>;
  const config =
    (c.priorityFee === null ? 0 : 8) +
    4 *
      ["computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize"].filter((k) => c[k] !== null)
        .length;
  let instructions = 0;
  for (const ix of p.transaction.message.instructions as Loose[]) {
    instructions += 4 + ix.accounts.length + decodeB58Length(ix.data);
  }
  const header = 1 + 3 + 4 + 32 + 1 + 1;
  return (
    header +
    32 * p.transaction.message.accountKeys.length +
    config +
    instructions +
    64 * p.transaction.signatures.length
  );
}

describe("Raydium CPMM swap decoder: Solana v1 (SIMD-0385), synthetic fixtures", () => {
  it("V1-01: a valid synthetic v1 swap decodes under cap 1 exactly as the same legacy swap", () => {
    const legacy = expectDecoded(decode(simpleBuy()));
    const v1 = expectDecoded(decode(v1Tx(), POOL_A, CAP1));
    expect(v1.events).toEqual(legacy.events);
    expect(v1.diagnostics).toEqual(legacy.diagnostics);
    expect(Object.isFrozen(v1.events[0])).toBe(true);
    // ComputeBudgetProgram instructions are configuration no-ops: ordinary non-CPMM instructions.
    const withBudget = expectDecoded(
      decode(v1Tx({ top: [computeBudgetNoOp(), swapIx({ side: "BUY" })] }), POOL_A, CAP1),
    );
    expect(withBudget.events[0]).toMatchObject({ outerInstructionIndex: 1, side: "BUY" });
    expect(withBudget.diagnostics).toMatchObject({ topLevelInstructions: 2, targetSwaps: 1 });
    // SELL, the other orientation, an all-null config, and every field at its documented edges.
    expectDecoded(decode(v1Tx({ top: [swapIx({ side: "SELL" })] }), POOL_A, CAP1));
    expectDecoded(decode(v1Tx({ top: [swapIx({ side: "BUY", pool: POOL_B })] }), POOL_B, CAP1));
    expectDecoded(decode(v1Tx({}, { ...NULL_CONFIG }), POOL_A, CAP1));
    for (const config of [
      { ...NULL_CONFIG, priorityFee: 0, computeUnitLimit: 0, loadedAccountsDataSizeLimit: 0 },
      { ...NULL_CONFIG, priorityFee: Number.MAX_SAFE_INTEGER },
      { ...NULL_CONFIG, computeUnitLimit: 0xffff_ffff, loadedAccountsDataSizeLimit: 0xffff_ffff },
      { ...NULL_CONFIG, heapSize: 32 * 1024 },
      { ...NULL_CONFIG, heapSize: 64 * 1024 },
      { ...NULL_CONFIG, heapSize: 256 * 1024 },
    ]) {
      expectDecoded(decode(v1Tx({}, config), POOL_A, CAP1));
    }
    // loadedAddresses may be empty, absent or null (static accounts only).
    for (const loaded of [undefined, null]) {
      const p = v1Tx();
      if (loaded === undefined) delete p.meta.loadedAddresses;
      else p.meta.loadedAddresses = loaded;
      expectDecoded(decode(p, POOL_A, CAP1));
    }
    // No target swap, and a recorded failure, keep their usual outcomes on v1.
    const none = decode(v1Tx({ top: [memoIx(undefined, [PAYER])] }), POOL_A, CAP1);
    expect(none.status).toBe("NO_MATCHING_SWAPS");
    expect(decode(v1Tx({ err: { InstructionError: [0, { Custom: 1 }] } }), POOL_A, CAP1)).toEqual({
      ok: false,
      status: "TRANSACTION_FAILED",
      signature: signatureOf(1),
      slot: 312_000_000,
      events: [],
    });
  });

  it("V1-02: response versions are bound to the request policy; legacy and v0 are unchanged", () => {
    // Cap 0 (explicit, or omitted: the historical default) refuses v1 exactly as before.
    for (const options of [RECEIPT, CAP0]) {
      const r = decode(v1Tx(), POOL_A, options);
      expectRefused(r, "UNSUPPORTED_TRANSACTION_VERSION", "1");
      expect((r as Loose).message).toBe(
        "only legacy and v0 are supported, with the version field present",
      );
    }
    // Legacy and v0 decode identically under every policy (regression).
    const v0 = () =>
      build({ signers: [PAYER], top: [swapIx({ side: "BUY" })], loaded: [USER_WSOL, USER_TOKEN] });
    for (const options of [RECEIPT, CAP0, CAP1]) {
      expect(decode(simpleBuy(), POOL_A, options)).toEqual(decode(simpleBuy()));
      expect(decode(v0(), POOL_A, options)).toEqual(decode(v0()));
    }
    expectDecoded(decode(v0(), POOL_A, CAP1));
    // Unknown and malformed versions stay refused under cap 1 (a number above the cap included).
    const cases: [unknown, string][] = [
      [2, "2"],
      [-1, "-1"],
      ["1", "1"],
      ["v1", "v1"],
      [null, "null"],
      [true, "true"],
      [1.5, "1.5"],
      [129, "129"],
    ];
    for (const [version, detail] of cases) {
      const p = v1Tx();
      p.version = version;
      expectRefused(decode(p, POOL_A, CAP1), "UNSUPPORTED_TRANSACTION_VERSION", detail);
    }
    const missing = v1Tx();
    delete missing.version;
    expectRefused(
      decode(missing, POOL_A, CAP1),
      "UNSUPPORTED_TRANSACTION_VERSION",
      "VERSION_MISSING",
    );
    // The policy itself must be exactly 0 or 1.
    for (const cap of [2, -1, "1", null, 1.5, true, undefined]) {
      expectRefused(
        decode(v1Tx(), POOL_A, { ...RECEIPT, maxSupportedTransactionVersion: cap }),
        "INVALID_OPTIONS",
        "maxSupportedTransactionVersion",
      );
    }
  });

  it("V1-03: v1 is static-only, and transactionConfig belongs to v1 alone", () => {
    const refusedV1 = (edit: (p: Loose) => void, reason: string, detail: string) => {
      const p = v1Tx();
      edit(p);
      expectRefused(decode(p, POOL_A, CAP1), reason, detail);
    };
    // No address lookup tables in any form (Agave omits the key for v1).
    const lookupForms = [
      [],
      null,
      [{ accountKey: key(98), writableIndexes: [0], readonlyIndexes: [] }],
    ];
    for (const lookups of lookupForms) {
      refusedV1(
        (p) => (p.transaction.message.addressTableLookups = lookups),
        "MALFORMED_ACCOUNT_KEYS",
        "V1_LOOKUPS",
      );
    }
    for (const loaded of [
      { writable: [key(50)], readonly: [] },
      { writable: [], readonly: [key(50)] },
      [],
      { writable: [] },
    ]) {
      refusedV1((p) => (p.meta.loadedAddresses = loaded), "MALFORMED_ACCOUNT_KEYS", "V1_LOADED");
    }
    // Static keys stay unique and canonical, and signatures match the header, on v1.
    refusedV1(
      (p) => p.transaction.message.accountKeys.push(p.transaction.message.accountKeys[1]),
      "MALFORMED_ACCOUNT_KEYS",
      "DUPLICATE",
    );
    refusedV1(
      (p) => (p.transaction.message.accountKeys[2] = "not-a-key"),
      "MALFORMED_ACCOUNT_KEYS",
      "KEY",
    );
    refusedV1(
      (p) => p.transaction.signatures.push(signatureOf(9)),
      "INVALID_PAYLOAD",
      "SIGNATURES",
    );
    // transactionConfig is required on v1 ...
    refusedV1(
      (p) => delete p.transaction.message.transactionConfig,
      "INVALID_PAYLOAD",
      "TRANSACTION_CONFIG",
    );
    // ... and forbidden on legacy and v0 (even null), under every policy.
    const v0 = build({ signers: [PAYER], top: [swapIx({ side: "BUY" })], loaded: [USER_WSOL] });
    for (const base of [simpleBuy(), v0]) {
      for (const config of [{ ...V1_CONFIG }, null]) {
        const p = JSON.parse(JSON.stringify(base));
        p.transaction.message.transactionConfig = config;
        for (const options of [RECEIPT, CAP1]) {
          expectRefused(
            decode(p, POOL_A, options),
            "INVALID_PAYLOAD",
            "TRANSACTION_CONFIG_FORBIDDEN",
          );
        }
      }
    }
  });

  it("V1-04: malformed configurations and unsafe values are refused; nothing is rounded", () => {
    const refused = (config: unknown, reason = "INVALID_PAYLOAD", detail = "TRANSACTION_CONFIG") =>
      expectRefused(decode(v1Tx({}, config), POOL_A, CAP1), reason, detail);
    refused(null);
    refused([]);
    refused("config");
    refused({});
    const without = (k: keyof typeof V1_CONFIG) =>
      Object.fromEntries(Object.entries(V1_CONFIG).filter(([key]) => key !== k));
    const missingHeap = without("heapSize");
    refused(missingHeap);
    refused({ ...V1_CONFIG, priority_fee: 1 });
    refused({ ...V1_CONFIG, requestedHeapSize: 32_768 });
    // Exactly four keys, one of them renamed (snake_case is not Agave's serialization).
    refused({ ...missingHeap, heap_size: null });
    refused({ ...without("priorityFee"), priority_fee: 5_000 });
    const fields = ["priorityFee", "computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize"];
    for (const field of fields) {
      for (const bad of [-1, 1.5, "5", true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
        refused({ ...V1_CONFIG, [field]: bad });
      }
    }
    for (const field of ["computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize"]) {
      refused({ ...V1_CONFIG, [field]: 2 ** 32 });
      refused({ ...V1_CONFIG, [field]: 2 ** 53 });
    }
    // Heap size: a 1 KiB multiple in [32 KiB, 256 KiB] when set.
    for (const heap of [0, 1_024, 32_767, 32_768 + 512, 33_000, 256 * 1024 + 1_024]) {
      refused({ ...V1_CONFIG, heapSize: heap });
    }
    // A u64 priority fee beyond exact JSON representation: an application limit, never rounded.
    for (const fee of [2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1e300]) {
      refused(
        { ...V1_CONFIG, priorityFee: fee },
        "EVIDENCE_LIMIT_EXCEEDED",
        "TRANSACTION_CONFIG_UNSAFE_INTEGER",
      );
    }
    // A config refusal comes before anything else is read (here, missing inner instructions).
    const early = v1Tx({ innerNull: true }, { ...V1_CONFIG, heapSize: 1 });
    expectRefused(decode(early, POOL_A, CAP1), "INVALID_PAYLOAD", "TRANSACTION_CONFIG");
  });

  it("V1-05: SIMD-0385 protocol constraints are distinct from application limits", () => {
    const extraKeys = (n: number) => Array.from({ length: n }, (_, i) => key(120 + i));
    // Signatures: at most 12 on v1 (legacy is unaffected).
    const signers = (n: number) => [PAYER, ...extraKeys(n - 1)];
    expectDecoded(decode(v1Tx({ signers: signers(12) }), POOL_A, CAP1));
    expectRefused(
      decode(v1Tx({ signers: signers(13) }), POOL_A, CAP1),
      "INVALID_PAYLOAD",
      "V1_SIGNATURES",
    );
    expectDecoded(decode(simpleBuy({ signers: signers(13) })));
    // Static accounts: at most 64 (the application limit of 256 is wider).
    const withKeys = (base: Loose, total: number) => {
      const have = base.transaction.message.accountKeys.length as number;
      base.transaction.message.accountKeys.push(...extraKeys(total - have));
      return base;
    };
    expectDecoded(decode(withKeys(v1Tx(), 64), POOL_A, CAP1));
    expectRefused(decode(withKeys(v1Tx(), 65), POOL_A, CAP1), "INVALID_PAYLOAD", "V1_ACCOUNT_KEYS");
    expectDecoded(decode(withKeys(simpleBuy(), 65)));
    // Instructions: at most 64 (a protocol refusal, before the application's own bound).
    const memos = (n: number) => Array.from({ length: n }, () => memoIx());
    expectDecoded(decode(v1Tx({ top: [swapIx({ side: "BUY" }), ...memos(63)] }), POOL_A, CAP1));
    expectRefused(
      decode(v1Tx({ top: [swapIx({ side: "BUY" }), ...memos(64)] }), POOL_A, CAP1),
      "INVALID_PAYLOAD",
      "V1_INSTRUCTIONS",
    );
    expectRefused(
      decode(simpleBuy({ top: [swapIx({ side: "BUY" }), ...memos(64)] })),
      "EVIDENCE_LIMIT_EXCEEDED",
      "TOP_LEVEL",
    );
    // Accounts per instruction: at most 255 on v1 (the application allows 256).
    const wide = (n: number) =>
      memoIx(
        undefined,
        Array.from({ length: n }, () => PAYER),
      );
    expectDecoded(decode(v1Tx({ top: [swapIx({ side: "BUY" }), wide(255)] }), POOL_A, CAP1));
    expectRefused(
      decode(v1Tx({ top: [swapIx({ side: "BUY" }), wide(256)] }), POOL_A, CAP1),
      "INVALID_PAYLOAD",
      "V1_INSTRUCTION_ACCOUNTS",
    );
    expectDecoded(decode(simpleBuy({ top: [swapIx({ side: "BUY" }), wide(256)] })));
    // Serialized size: exactly 4,096 bytes is accepted, one more byte is refused.
    const sized = (dataBytes: number, config: unknown = { ...V1_CONFIG }) =>
      v1Tx({ top: [swapIx({ side: "BUY" }), memoIx(new Uint8Array(dataBytes).fill(7))] }, config);
    const base = v1Bytes(sized(1)) - 1;
    const atLimit = sized(4_096 - base);
    expect(v1Bytes(atLimit)).toBe(4_096);
    expectDecoded(decode(atLimit, POOL_A, CAP1));
    const over = sized(4_097 - base);
    expect(v1Bytes(over)).toBe(4_097);
    expectRefused(decode(over, POOL_A, CAP1), "INVALID_PAYLOAD", "V1_TRANSACTION_SIZE");
    // Config values count towards the size (V1_CONFIG: an 8-byte priority fee and two u32s, 16 bytes).
    const fits = sized(4_096 - base + 16, { ...NULL_CONFIG });
    expect(v1Bytes(fits)).toBe(4_096);
    expectDecoded(decode(fits, POOL_A, CAP1));
    const heapOver = sized(4_096 - base + 16, { ...NULL_CONFIG, heapSize: 32 * 1024 });
    expect(v1Bytes(heapOver)).toBe(4_100);
    expectRefused(decode(heapOver, POOL_A, CAP1), "INVALID_PAYLOAD", "V1_TRANSACTION_SIZE");
    // The size bound is v1-only: the same oversized message decodes as legacy.
    const legacyOver = simpleBuy({
      top: [swapIx({ side: "BUY" }), memoIx(new Uint8Array(4_097 - base).fill(7))],
    });
    expectDecoded(decode(legacyOver));
  });
});
