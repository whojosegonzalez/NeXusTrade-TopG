/**
 * SYNTHETIC offline support for the Stage A precheck and handoff tests: schema-shaped RPC and
 * DexScreener responses (not captures), a mocked transport and the shared virtual scheduler.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
} from "../research/pilot/PoolInitializationParser.js";
import { SPL_TOKEN_PROGRAM_ID, WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import {
  START_MS,
  TEST_RPC_URL,
  VirtualScheduler,
  drive,
  sig,
} from "../candidate-scanner/PaperRollingCandidateFlowProvider.test-support.js";
import { syntheticDexScreenerPair } from "../candidate-scanner/fixtures/SanitizedDexScreenerTokenPairsFixture.js";
import {
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION as FEE,
  runFreshPoolPrecheck,
  type FreshPoolPrecheckDeps,
} from "./fresh-amm-v4-precheck.js";

export { START_MS, TEST_RPC_URL, VirtualScheduler, drive, sig, FEE, WSOL_MINT };

/** SYNTHETIC deterministic 32-byte base58 key. */
export const key = (label: string) =>
  encodeBase58(Uint8Array.from(createHash("sha256").update(`SYNTHETIC:${label}`).digest()));

export const SYNTHETIC_RPC_KEY = "SYNTHETIC-PRECHECK-RPC-KEY-123456";
export const ENV = Object.freeze({
  SOLANA_RPC_URL: `${TEST_RPC_URL}/?api-key=${SYNTHETIC_RPC_KEY}`,
});
export const NOW_SEC = Math.floor(START_MS / 1000);
export const POOL = key("pool");
export const MINT = key("mint");

export interface SyntheticInit {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly poolId?: string;
  readonly coinMint?: string;
  readonly pcMint?: string;
  readonly feeDestination?: string;
  readonly openTime?: number;
  readonly err?: unknown;
  /** Override the result entirely (e.g. null or a malformed shape). */
  readonly result?: unknown;
  /** Override the returned transaction signature. */
  readonly returnedSignature?: string;
  /** Override the echoed JSON-RPC id (the request id plus this). */
  readonly idOffset?: number;
}

/** SYNTHETIC getTransaction result (json encoding) with one AMM v4 initialize2. */
export function initTransactionResult(s: SyntheticInit): Record<string, unknown> {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
    s.poolId ?? POOL,
    key("authority"),
    key("open-orders"),
    key("lp-mint"),
    s.coinMint ?? MINT,
    s.pcMint ?? WSOL_MINT,
    key("coin-vault"),
    key("pc-vault"),
    key("target-orders"),
    key("amm-config"),
    s.feeDestination ?? FEE,
    key("market-program"),
    key("market"),
    key("creator"),
    key("user-coin"),
    key("user-pc"),
    key("user-lp"),
    RAYDIUM_AMM_V4_PROGRAM_ID,
  ];
  const data = Buffer.alloc(26);
  data.writeUInt8(1, 0);
  data.writeUInt8(254, 1);
  data.writeBigUInt64LE(BigInt(s.openTime ?? s.blockTime), 2);
  data.writeBigUInt64LE(100_000_000_000n, 10);
  data.writeBigUInt64LE(50_000_000_000n, 18);
  return {
    slot: s.slot,
    blockTime: s.blockTime,
    version: 0,
    meta: {
      err: s.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [],
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: [s.returnedSignature ?? s.signature],
      message: {
        accountKeys: accounts,
        instructions: [
          {
            programIdIndex: 21,
            accounts: Array.from({ length: 21 }, (_, i) => i),
            data: encodeBase58(Uint8Array.from(data)),
          },
        ],
      },
    },
  };
}

export interface SignatureRecord {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err?: unknown;
}

/** SYNTHETIC DexScreener tokens response with the exact pair for `pool`/`mint`. */
export function marketResponse(
  pairCreatedAtMs: number | undefined,
  pool = POOL,
  mint = MINT,
  overrides: Record<string, unknown> = {},
): unknown {
  const pair = syntheticDexScreenerPair(
    { pairCreatedAtMs: pairCreatedAtMs ?? 0 },
    {
      url: `https://dexscreener.com/solana/${pool.toLowerCase()}`,
      pairAddress: pool,
      baseToken: { address: mint, name: "SYNTHETIC Fresh", symbol: "FRESH" },
      ...overrides,
    },
  );
  if (pairCreatedAtMs === undefined) delete (pair as Record<string, unknown>).pairCreatedAt;
  return { schemaVersion: "1.0.0", pairs: [pair] };
}

export interface Scenario {
  readonly signatures: readonly SignatureRecord[] | (() => Response);
  readonly transactions?: readonly SyntheticInit[];
  readonly transactionResponse?: (signature: string) => Response | undefined;
  readonly market?: () => Response;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Mocked transports and virtual time for one precheck run (SYNTHETIC). */
export function precheckEnv(scenario: Scenario, root?: string) {
  const sched = new VirtualScheduler(START_MS);
  const clock = () => sched.now;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
    clearTimeout: (h: unknown) => sched.clear(h),
  };
  const fetchLog: { url: string; method: string; atMs: number; rpcMethod: string | null }[] = [];
  const delay = (signal: AbortSignal | null | undefined) =>
    new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), 100, "harness");
      signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const isRpc = new URL(url).origin === new URL(TEST_RPC_URL).origin;
    const body = isRpc
      ? (JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] })
      : null;
    fetchLog.push({
      url,
      method: init?.method ?? "GET",
      atMs: sched.now,
      rpcMethod: body?.method ?? null,
    });
    await delay(init?.signal);
    if (!isRpc) return scenario.market ? scenario.market() : json(marketResponse(undefined));
    if (body!.method === "getSignaturesForAddress") {
      if (typeof scenario.signatures === "function") return scenario.signatures();
      return json({ jsonrpc: "2.0", id: body!.id, result: scenario.signatures });
    }
    if (body!.method === "getTransaction") {
      const signature = body!.params[0] as string;
      const custom = scenario.transactionResponse?.(signature);
      if (custom) return custom;
      const t = scenario.transactions?.find((x) => x.signature === signature);
      const result = t === undefined ? null : "result" in t ? t.result : initTransactionResult(t);
      return json({ jsonrpc: "2.0", id: body!.id + (t?.idOffset ?? 0), result });
    }
    return json({ jsonrpc: "2.0", id: body!.id, error: { code: -32601 } });
  }) as unknown as typeof fetch;
  const projectRoot = root ?? mkdtempSync(path.join(os.tmpdir(), "topg-precheck-"));
  const lines: string[] = [];
  const deps: FreshPoolPrecheckDeps = {
    env: ENV,
    loadEnvironment: () => undefined,
    fetchFn,
    clock,
    timers,
    projectRoot,
    log: (l) => lines.push(l),
  };
  const run = (name: string, live = true) =>
    drive(
      sched,
      runFreshPoolPrecheck(
        ["--out-dir", `data/research/prechecks/${name}`, ...(live ? ["--live"] : [])],
        deps,
      ),
    );
  return { sched, fetchLog, projectRoot, lines, deps, run };
}

/** The standard SYNTHETIC selection page: one failed, one undated, two nonmatching or matching, one beyond the sample, one too old. */
export function standardPage(): SignatureRecord[] {
  return [
    {
      signature: sig(101),
      slot: 1_000,
      blockTime: NOW_SEC - 10,
      err: { InstructionError: [0, "Custom"] },
    },
    { signature: sig(102), slot: 999, blockTime: null },
    { signature: sig(103), slot: 998, blockTime: NOW_SEC - 60 },
    { signature: sig(104), slot: 997, blockTime: NOW_SEC - 120 },
    { signature: sig(105), slot: 996, blockTime: NOW_SEC - 200 },
    { signature: sig(106), slot: 995, blockTime: NOW_SEC - 5_000 },
  ].map((r) => ({ err: null, ...r }));
}

/** SYNTHETIC timestamps of the standard match (three distinct sources). */
export const MATCH_BLOCK_TIME = NOW_SEC - 120;
export const MATCH_OPEN_TIME = MATCH_BLOCK_TIME - 30;
export const MATCH_PAIR_CREATED_AT_MS = (MATCH_BLOCK_TIME + 2) * 1000 + 500;

/** Standard scenario: the newest eligible is WSOL-base (non-match), the next is the match. */
export function standardScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    signatures: standardPage(),
    transactions: [
      {
        signature: sig(103),
        slot: 998,
        blockTime: NOW_SEC - 60,
        poolId: key("wsol-base-pool"),
        coinMint: WSOL_MINT,
        pcMint: key("other-mint"),
      },
      { signature: sig(104), slot: 997, blockTime: MATCH_BLOCK_TIME, openTime: MATCH_OPEN_TIME },
      { signature: sig(105), slot: 996, blockTime: NOW_SEC - 200 },
    ],
    market: () => json(marketResponse(MATCH_PAIR_CREATED_AT_MS)),
    ...overrides,
  };
}

export { json };
