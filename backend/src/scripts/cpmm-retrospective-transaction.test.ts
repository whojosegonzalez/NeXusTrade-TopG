/**
 * Retrospective CPMM transaction retrieval: offline tests with SYNTHETIC data only.
 *
 * Every source capture here is a synthetic, schema-2-shaped directory written to a temporary root
 * (the fixture pool, a cap-0 request and a -32015 error); no sealed capture is read. Every
 * transaction response is SYNTHETIC (the legacy builder's static-only message, given a version and,
 * for v1, the four-key `transactionConfig` Agave 318c00ca serializes). Acquisition runs only
 * against an injected fetch, a virtual clock and virtual timers, with a synthetic credential.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";
import {
  CANONICAL_CPMM_AUTH_BUMP,
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateSuccess,
} from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import {
  CPMM_SWAP_BASE_INPUT_DISCRIMINATOR,
  CPMM_SWAP_EVENT_DISCRIMINATOR,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../candidate-scanner/RaydiumCpmmSwapDecoder.js";
import { cpmmGetTransactionRequestBody } from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
import {
  RETRO_EXIT_CODES,
  RETRO_FILES,
  RETRO_LIMITS,
  RETRO_NON_CERTIFICATIONS,
  RETRO_OWNER,
  RETRO_PURPOSE,
  RETRO_SOURCE,
  RETRO_USAGE,
  bindRetrospectiveSource,
  buildRetrospectivePlan,
  createRetrospectiveClock,
  createRetrospectiveRunFailures,
  printableRetrospectiveError,
  retrospectiveVerifyExitCode,
  runCpmmRetrospectiveTransactionCli,
  verifyRetrospectiveEvidence,
  type RetroCliDeps,
  type RetrospectiveSourceDeps,
  type RetrospectiveSourceSpec,
} from "./cpmm-retrospective-transaction.js";

type Loose = ReturnType<typeof JSON.parse>;
const X = RETRO_EXIT_CODES;
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const RPC_KEY = "Zq7RetroKeyOnly-97531";
const RPC_URL = `https://rpc.example.invalid/?api-key=${RPC_KEY}`;
const START_MS = 1_795_900_000_000;
const OUT_REL = "data/research/cpmm-retrospective-transactions/retro-01";
const SLOT = 400_000_001;
const RECEIVED_AT = 1_795_500_000_123;
const BLOCK_TIME = 1_795_500_000;

// ---------------------------------------------------------------------------------------------
// Synthetic pool, signatures and transactions
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
const SIG = signatureOf(7);
const PAYER = key(1);
const USER_WSOL = key(4);
const USER_TOKEN = key(5);
const AMM_CONFIG = key(6);
const OBSERVATION = key(7);
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CANDIDATE = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

const vaultBuffer = (mint: string, raw: bigint) =>
  createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: mint,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: raw,
    state: 1,
  });
const ACCOUNTS = {
  pool: {
    address: FIXTURE_CPMM_POOL_ADDRESS,
    ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
    slot: 300_000_000,
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
  vault0: {
    address: FIXTURE_CPMM_TOKEN_0_VAULT,
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: 300_000_000,
    data: vaultBuffer(CANDIDATE, 10_000_000_000n),
  },
  vault1: {
    address: FIXTURE_CPMM_TOKEN_1_VAULT,
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: 300_000_000,
    data: vaultBuffer(WSOL_MINT, 50_000_000_000n),
  },
};
function adapted(): RaydiumCpmmPoolStateSuccess {
  const r = adaptRaydiumCpmmPoolState({
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE },
    poolAccount: ACCOUNTS.pool,
    vault0Account: ACCOUNTS.vault0,
    vault1Account: ACCOUNTS.vault1,
  });
  if (!r.ok) throw new Error("fixture pool refused");
  return r;
}
const POOL = adapted();

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
const memoIx = (): Ix => ({ program: MEMO, accounts: [PAYER], data: Uint8Array.from([1]) });

/** A SYNTHETIC json-encoding getTransaction result; `version` 1 adds a transactionConfig. */
function txResult(version: unknown, top: Ix[] = [swapIx()], sig = SIG, slot = SLOT): Loose {
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
    logs.push(`Program ${ix.program} success`);
  };
  top.forEach((t) => log(t, 1));
  const message: Loose = {
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0,
    },
    accountKeys: keys,
    recentBlockhash: key(99),
    instructions: top.map((t) => compile(t, null)),
  };
  if (version === 1) {
    message.transactionConfig = {
      priorityFee: 5_000,
      computeUnitLimit: 200_000,
      loadedAccountsDataSizeLimit: null,
      heapSize: null,
    };
  }
  if (version === 0) message.addressTableLookups = [];
  const result: Loose = {
    slot,
    blockTime: BLOCK_TIME,
    transaction: { signatures: [sig], message },
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: top
        .map((t, index) => ({ index, instructions: (t.children ?? []).map((c) => compile(c, 2)) }))
        .filter((g) => g.instructions.length > 0),
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: logs,
    },
  };
  if (version !== undefined) result.version = version;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Synthetic source capture (schema-2-shaped files; never a sealed capture)
// ---------------------------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const textPayload = (text: string) => {
  const b = Buffer.from(text, "utf8");
  return {
    originalBytes: b.length,
    originalSha256: sha(b),
    storedEncoding: "utf8",
    stored: text,
    storedBytes: b.length,
    storedSha256: sha(b),
    payloadRedacted: false,
    redactions: 0,
    withheldReason: null,
  };
};
const binaryPayload = (b: Buffer) => ({
  originalBytes: b.length,
  originalSha256: sha(b),
  storedEncoding: "base64",
  stored: b.toString("base64"),
  storedBytes: b.length,
  storedSha256: sha(b),
  payloadRedacted: false,
  redactions: 0,
  withheldReason: null,
});
const tagged = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x)));

const SOURCE_OBS = "data/research/cpmm-observations/fixture-source";
const SOURCE_ACQ = "data/research/cpmm-acquisitions/fixture-source";
const ERROR_TEXT =
  'Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1';

interface SourceOverrides {
  exchange?: (ex: Loose) => void;
  errorBody?: (b: Loose) => void;
  requestCap?: number;
  notifications?: (n: Loose[]) => void;
  records?: (r: Loose[]) => void;
  poolContext?: (c: Loose) => void;
  omit?: string;
}

/** Writes a synthetic source capture and returns the spec that pins it (base semantics fixed). */
function writeSource(root: string, o: SourceOverrides = {}): RetrospectiveSourceSpec {
  const obs = path.join(root, ...SOURCE_OBS.split("/"));
  const acq = path.join(root, ...SOURCE_ACQ.split("/"));
  mkdirSync(path.join(obs, "exchanges"), { recursive: true });
  mkdirSync(acq, { recursive: true });
  const acqManifest = `${JSON.stringify({ kind: "SYNTHETIC_ACQUISITION_MANIFEST" })}\n`;
  writeFileSync(path.join(acq, "evidence-manifest.json"), acqManifest);
  const requestText = cpmmGetTransactionRequestBody(SIG, 4, (o.requestCap ?? 0) as 0 | 1);
  const errorBody: Loose = { jsonrpc: "2.0", id: 4, error: { code: -32015, message: ERROR_TEXT } };
  o.errorBody?.(errorBody);
  const errorText = JSON.stringify(errorBody);
  const exchange: Loose = {
    kind: "CPMM_OBSERVATION_EXCHANGE",
    version: 1,
    entry: {
      seq: 4,
      lane: "SOLANA_RPC",
      owner: "FLOW",
      purpose: "CPMM_GET_TRANSACTION",
      requestedIdentity: SIG,
      jsonRpcId: 4,
      dispatchedAtMs: RECEIVED_AT + 1,
      completedAtMs: RECEIVED_AT + 100,
      httpStatus: 200,
      bodyComplete: true,
      error: null,
    },
    method: "POST",
    requestBody: textPayload(requestText),
    bodyState: "COMPLETE",
    body: textPayload(errorText),
    observedBodyBytes: Buffer.byteLength(errorText),
    maxResponseBytes: 262_144,
  };
  o.exchange?.(exchange);
  const notifications: Loose[] = [
    {
      sequence: 1,
      signature: signatureOf(1),
      slot: SLOT - 5,
      receivedAtMs: RECEIVED_AT - 900,
      frameSha256: "a".repeat(64),
    },
    {
      sequence: 2,
      signature: SIG,
      slot: SLOT,
      receivedAtMs: RECEIVED_AT,
      frameSha256: "b".repeat(64),
    },
  ];
  o.notifications?.(notifications);
  const records: Loose[] = [
    {
      sequence: 2,
      signature: SIG,
      notifiedSlot: SLOT,
      disposition: "UNRESOLVED",
      blockingClass: "TRANSACTION_UNAVAILABLE",
      factKind: "RPC_ERROR",
      factCode: "JSON_RPC_ERROR",
    },
  ];
  o.records?.(records);
  const poolContext: Loose = {
    kind: "CPMM_OBSERVATION_POOL_CONTEXT",
    version: 2,
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE },
    accounts: Object.fromEntries(
      Object.entries(ACCOUNTS).map(([n, a]) => [
        n,
        {
          address: a.address,
          ownerProgramId: a.ownerProgramId,
          slot: a.slot,
          data: binaryPayload(a.data),
        },
      ]),
    ),
    adaptedPool: tagged(POOL),
    acquisition: "ACQUIRED_BOUND",
    acquisitionManifestSha256: sha(acqManifest),
  };
  o.poolContext?.(poolContext);
  const files: [string, string][] = [
    ["collector.json", JSON.stringify({ notifications: { status: "READ", value: notifications } })],
    ["exchanges/000004.json", JSON.stringify(exchange)],
    ["ledger.json", JSON.stringify({ records: { status: "READ", value: records } })],
    ["pool-context.json", JSON.stringify(poolContext)],
  ];
  const entries = [];
  for (const [rel, text] of files) {
    if (rel === o.omit) continue;
    writeFileSync(path.join(obs, ...rel.split("/")), text);
    entries.push({ path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  const manifest = JSON.stringify({ evidenceSchemaVersion: 2, files: entries });
  writeFileSync(path.join(obs, "cpmm-observation-manifest.json"), manifest);
  return {
    runId: "fixture-source",
    observationDir: SOURCE_OBS,
    acquisitionDir: SOURCE_ACQ,
    evidenceSchemaVersion: 2,
    observationManifestSha256: sha(manifest),
    acquisitionManifestSha256: sha(acqManifest),
    poolAddress: FIXTURE_CPMM_POOL_ADDRESS,
    candidateMint: CANDIDATE,
    signature: SIG,
    slot: SLOT,
    notificationSequence: 2,
    notificationReceivedAtMs: RECEIVED_AT,
    notificationFrameSha256: "b".repeat(64),
    ledgerSequence: 2,
    exchangePath: "exchanges/000004.json",
    exchangeSha256: sha(files[1]![1]),
    exchangeSeq: 4,
    exchangeJsonRpcId: 4,
    requestOriginalSha256: sha(cpmmGetTransactionRequestBody(SIG, 4, 0)),
    responseOriginalSha256: sha(
      JSON.stringify({ jsonrpc: "2.0", id: 4, error: { code: -32015, message: ERROR_TEXT } }),
    ),
    rpcErrorCode: -32015,
    versionClaim: 1,
  };
}

/** Fake source verifiers: the full bundle verifiers are covered by their own suites. */
function verifiers(spec: RetrospectiveSourceSpec, over: { obs?: Loose; acq?: Loose } = {}) {
  const calls = { obs: 0, acq: 0 };
  const deps: RetrospectiveSourceDeps = {
    verifyObservation: () => {
      calls.obs++;
      return {
        integrity: { ok: true, problems: [] },
        manifestSha256: spec.observationManifestSha256,
        acquisitionBinding: { status: "REPRODUCED" },
        poolContextProvenance: "ACQUIRED_BOUND",
        rederivation: { components: { poolContext: { status: "REPRODUCED" } } },
        ...over.obs,
      };
    },
    verifyAcquisition: () => {
      calls.acq++;
      return {
        integrity: "VERIFIED",
        computed: "ACQUIRED_REPRODUCED",
        manifestSha256: spec.acquisitionManifestSha256,
        ...over.acq,
      };
    },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------------------------
// Virtual scheduler, scripted fetch and CLI harness
// ---------------------------------------------------------------------------------------------

class VirtualScheduler {
  now = START_MS;
  private nextId = 1;
  private readonly queue: { id: number; at: number; fn: () => void }[] = [];
  add(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.queue.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  }
  clear(handle: unknown): void {
    const i = this.queue.findIndex((q) => q.id === Number(handle));
    if (i !== -1) this.queue.splice(i, 1);
  }
  hasPending(): boolean {
    return this.queue.length > 0;
  }
  async runTo(target: number): Promise<void> {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i]!;
        if (q.at <= target && (idx === -1 || q.at < this.queue[idx]!.at)) idx = i;
      }
      if (idx === -1) break;
      const [q] = this.queue.splice(idx, 1);
      this.now = Math.max(this.now, q!.at);
      q!.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    if (target > this.now) this.now = target;
  }
}

interface FetchScript {
  status?: number;
  body?: (id: number) => string | Uint8Array;
  delayMs?: number;
  throwError?: string;
  ignoreAbort?: boolean;
}
const rpcResult = (result: unknown) => (id: number) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

function harness(
  o: {
    fetch?: FetchScript;
    source?: SourceOverrides;
    verifierOver?: { obs?: Loose; acq?: Loose };
  } = {},
) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "cpmm-retro-"));
  roots.push(projectRoot);
  const spec = writeSource(projectRoot, o.source);
  const v = verifiers(spec, o.verifierOver);
  const sched = new VirtualScheduler();
  const logs: string[] = [];
  const calls: { url: string; body: string }[] = [];
  let loadCalls = 0;
  const f = o.fetch ?? { body: rpcResult(txResult(1)) };
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body);
    calls.push({ url: String(input), body });
    await new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), f.delayMs ?? 100);
      if (!f.ignoreAbort) {
        init?.signal?.addEventListener(
          "abort",
          () => {
            sched.clear(id);
            reject(new Error(`aborted ${RPC_URL}`));
          },
          { once: true },
        );
      }
    });
    if (f.throwError !== undefined) throw new Error(f.throwError);
    const id = (JSON.parse(body) as { id: number }).id;
    const out = (f.body ?? rpcResult(txResult(1)))(id);
    return new Response(typeof out === "string" ? out : Buffer.from(out), {
      status: f.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => sched.add(fn, ms),
    clearTimeout: (h) => sched.clear(h),
  };
  const deps = (extra: Partial<RetroCliDeps> = {}): RetroCliDeps => ({
    env: { SOLANA_RPC_URL: RPC_URL },
    loadEnvironment: () => {
      loadCalls++;
    },
    fetchFn,
    clock: () => sched.now,
    timers,
    projectRoot,
    log: (l) => logs.push(l),
    spec,
    sourceDeps: v.deps,
    signals: { on: () => undefined, removeListener: () => undefined },
    ...extra,
  });
  async function drive<T>(p: Promise<T>, horizonMs = 30_000): Promise<T> {
    let settled = false;
    const tracked = p.finally(() => {
      settled = true;
    });
    // Observed here; the caller still receives the rejection through the returned promise.
    tracked.catch(() => undefined);
    while (!settled) {
      await new Promise<void>((r) => setImmediate(r));
      if (sched.hasPending()) await sched.runTo(START_MS + horizonMs);
    }
    return tracked;
  }
  const live = (extra: Partial<RetroCliDeps> = {}, args = ["--out-dir", OUT_REL, "--live"]) =>
    drive(runCpmmRetrospectiveTransactionCli(args, deps(extra)));
  return {
    projectRoot,
    spec,
    verifierCalls: v.calls,
    sched,
    logs,
    calls,
    get loadCalls() {
      return loadCalls;
    },
    deps,
    drive,
    live,
    outDir: path.join(projectRoot, ...OUT_REL.split("/")),
  };
}

function expectNoSecrets(h: ReturnType<typeof harness>): void {
  expect(h.logs.join("\n")).not.toContain(RPC_KEY);
  if (existsSync(h.outDir)) {
    for (const f of readdirSync(h.outDir)) {
      expect(readFileSync(path.join(h.outDir, f), "utf8"), f).not.toContain(RPC_KEY);
    }
  }
}
const readOut = (h: ReturnType<typeof harness>, f: string) =>
  JSON.parse(readFileSync(path.join(h.outDir, f), "utf8")) as Loose;
/** Rewrites one sealed file and its manifest digest consistently. */
function reseal(h: ReturnType<typeof harness>, f: string, mutate: (d: Loose) => void): void {
  const d = readOut(h, f);
  mutate(d);
  const text = `${JSON.stringify(d, null, 2)}\n`;
  writeFileSync(path.join(h.outDir, f), text);
  const m = readOut(h, RETRO_FILES.manifest);
  for (const e of m.files)
    if (e.path === f) Object.assign(e, { sha256: sha(text), bytes: Buffer.byteLength(text) });
  if (f === RETRO_FILES.retrieval) m.recordedOutcome = d.recorded.outcome;
  writeFileSync(path.join(h.outDir, RETRO_FILES.manifest), `${JSON.stringify(m, null, 2)}\n`);
}
const verifyOut = (h: ReturnType<typeof harness>, sourceDeps?: RetrospectiveSourceDeps) =>
  verifyRetrospectiveEvidence(h.outDir, {
    projectRoot: h.projectRoot,
    spec: h.spec,
    sourceDeps: sourceDeps ?? verifiers(h.spec).deps,
  });

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("cpmm-retrospective-transaction (synthetic, offline)", () => {
  it("RT01: pinned source, limits, owner and purpose; the module instantiates no tracker, ledger, collector or owner", () => {
    expect(RETRO_SOURCE).toEqual({
      runId: "cpmm-observation-03",
      observationDir: "data/research/cpmm-observations/cpmm-observation-03",
      acquisitionDir: "data/research/cpmm-acquisitions/cpmm-observation-03",
      evidenceSchemaVersion: 2,
      observationManifestSha256: "12f5fac06c54ba51d17e845a2e607ca8cfa72bf1566440851946a73cf8757f0e",
      acquisitionManifestSha256: "57f6f2329ca20d8e5df72ef167f609e58ddb13e0072b0bc9abdbf7d8390a84eb",
      poolAddress: "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh",
      candidateMint: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
      signature:
        "4XcLrDWBcAHkgmK8oF9PqeKitaJy1sNZG2xetTuL8EbazpGjexiCBo2BUGThoV2FgdG8h7AF58imedW2sjtBMimm",
      slot: 473_543_189,
      notificationSequence: 2,
      notificationReceivedAtMs: 1_795_566_034_813,
      notificationFrameSha256: "ab1139ded029ac5a5124f6daf2f8267a9d9804c3512132df4124968dcd30b505",
      ledgerSequence: 2,
      exchangePath: "exchanges/000004.json",
      exchangeSha256: "b3fbf21e56e46ada70366537298cdfe25cf5c01c00d3d3550bbe2ffa961ce827",
      exchangeSeq: 4,
      exchangeJsonRpcId: 4,
      requestOriginalSha256: "58f03595f81687ed8120ba7e4292199e120b0955046b3a672a54b0deb07cfd2e",
      responseOriginalSha256: "06009d74502daefb3a420a961c5fec52d365e177e686ba540a13ba5a9ca04780",
      rpcErrorCode: -32015,
      versionClaim: 1,
    });
    expect(Object.isFrozen(RETRO_SOURCE)).toBe(true);
    // The pinned source request is the exact cap-0 body the source run sent.
    expect(sha(cpmmGetTransactionRequestBody(RETRO_SOURCE.signature, 4, 0))).toBe(
      RETRO_SOURCE.requestOriginalSha256,
    );
    expect(RETRO_LIMITS).toMatchObject({
      httpRequests: 1,
      requestsAfterPreflightRefusal: 0,
      webSockets: 0,
      retries: 0,
      redirects: 0,
      pagination: 0,
      fallback: "NONE",
      automaticFollowUp: false,
      acquisitionDeadlineMs: 15_000,
      requestTimeoutMs: 10_000,
      cleanupGraceMs: 5_000,
      maxResponseBytes: 262_144,
      maxSupportedTransactionVersion: 1,
    });
    expect([RETRO_OWNER, RETRO_PURPOSE]).toEqual([
      "SECURITY",
      "CPMM_RETROSPECTIVE_GET_TRANSACTION",
    ]);
    expect(Object.values(RETRO_NON_CERTIFICATIONS).every((x) => x === false)).toBe(true);
    const src = readFileSync(
      fileURLToPath(new URL("./cpmm-retrospective-transaction.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      "RollingTradeFlowTracker",
      "CpmmResolutionAccountingLedger",
      "CpmmPoolNotificationCollector",
      "CpmmPoolConnectionOwner",
      "CpmmPoolObservationRecorder",
      "CpmmPoolWebSocketTransport",
      ".ingest(",
      "ingestTrade",
      "process.env.SOLANA",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // Only the reviewed modules are imported statically; configuration only inside --live.
    const imports = [...src.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
      "node:url",
      "node:util",
      "../candidate-scanner/ExactPoolHistoryEnumerator.js",
      "../candidate-scanner/PaperRequestSession.js",
      "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js",
      "../candidate-scanner/RaydiumCpmmSwapDecoder.js",
      "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js",
      "../paper/CanonicalPaths.js",
      "./cpmm-pool-acquisition-evidence.js",
      "./cpmm-pool-observation-evidence.js",
      "./evidence-credential-sanitizer.js",
    ]);
    expect([...src.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      "./paper-trading-daemon.js",
    ]);
  });

  it("RT02: --help reads nothing; the dry run binds the source read-only and is otherwise inert", async () => {
    const h = harness();
    const help = await h.drive(runCpmmRetrospectiveTransactionCli(["--help"], h.deps()));
    expect(help).toMatchObject({ mode: "HELP", exitCode: X.OK });
    expect(h.logs[0]).toBe(RETRO_USAGE);
    expect(h.verifierCalls).toEqual({ obs: 0, acq: 0 });
    const dry = await h.drive(runCpmmRetrospectiveTransactionCli(["--out-dir", OUT_REL], h.deps()));
    expect(dry).toMatchObject({ mode: "DRY_RUN", exitCode: X.OK, outDir: OUT_REL });
    expect(h.verifierCalls).toEqual({ obs: 1, acq: 1 });
    expect(h.calls).toHaveLength(0);
    expect(h.loadCalls).toBe(0);
    expect(existsSync(h.outDir)).toBe(false);
    const planLine = h.logs[h.logs.length - 1]!;
    expect(sha(planLine)).toBe(dry.planDigestSha256);
    const plan = JSON.parse(planLine) as Loose;
    expect(plan).toEqual(
      JSON.parse(
        JSON.stringify(buildRetrospectivePlan(h.spec, { outDir: OUT_REL, mode: "DRY_RUN" })),
      ),
    );
    expect(plan.request).toEqual({
      method: "POST",
      lane: "SOLANA_RPC",
      owner: "SECURITY",
      purpose: "CPMM_RETROSPECTIVE_GET_TRANSACTION",
      rpcMethod: "getTransaction",
      params: [
        SIG,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
      ],
    });
    expect(plan.source.exchange).toMatchObject({
      requestMaxSupportedTransactionVersion: 0,
      transactionPayload: false,
    });
    expect(h.logs).toContain("[DRY_RUN] Source binding: VERIFIED (fixture-source, read-only)");
    // Existing and misplaced output directories are refused before the source is read.
    mkdirSync(h.outDir, { recursive: true });
    await expect(
      runCpmmRetrospectiveTransactionCli(["--out-dir", OUT_REL, "--live"], h.deps()),
    ).rejects.toThrow(/\[OUTPUT_EXISTS\]/);
    await expect(
      runCpmmRetrospectiveTransactionCli(
        ["--out-dir", "data/research/elsewhere/r1", "--live"],
        h.deps(),
      ),
    ).rejects.toThrow(/\[CLI_INVALID_ARG\]/);
    expect(h.calls).toHaveLength(0);
    expect(h.loadCalls).toBe(0);
    expect(h.verifierCalls).toEqual({ obs: 1, acq: 1 });
  });

  it("RT03: a source-binding refusal sends nothing, loads nothing and writes nothing", async () => {
    const cases: [string, Parameters<typeof harness>[0], string][] = [
      [
        "observation not verified",
        { verifierOver: { obs: { integrity: { ok: false } } } },
        "SOURCE_OBSERVATION_NOT_VERIFIED",
      ],
      [
        "binding not reproduced",
        { verifierOver: { obs: { acquisitionBinding: { status: "MISMATCH" } } } },
        "SOURCE_OBSERVATION_NOT_VERIFIED",
      ],
      [
        "acquisition not reproduced",
        { verifierOver: { acq: { computed: "ACQUIRED_LIMITED" } } },
        "SOURCE_ACQUISITION_NOT_VERIFIED",
      ],
      [
        "other manifest digest",
        { verifierOver: { obs: { manifestSha256: "0".repeat(64) } } },
        "SOURCE_OBSERVATION_NOT_VERIFIED",
      ],
      ["cap-1 source request", { source: { requestCap: 1 } }, "SOURCE_EXCHANGE_REQUEST"],
      [
        "another error code",
        { source: { errorBody: (b) => (b.error.code = -32004) } },
        "SOURCE_EXCHANGE_RESPONSE",
      ],
      [
        "another purpose",
        { source: { exchange: (x) => (x.entry.purpose = "OTHER") } },
        "SOURCE_EXCHANGE_ENTRY",
      ],
      [
        "notification slot",
        { source: { notifications: (n) => (n[1].slot = SLOT + 1) } },
        "SOURCE_NOTIFICATION",
      ],
      [
        "duplicate notification",
        { source: { notifications: (n) => n.push({ ...n[1] }) } },
        "SOURCE_NOTIFICATION",
      ],
      [
        "ledger fact",
        { source: { records: (r) => (r[0].factKind = "RESOLVED_SWAPS") } },
        "SOURCE_LEDGER_RECORD",
      ],
      [
        "pool account bytes",
        {
          source: {
            poolContext: (c) => (c.accounts.vault1.data.stored = c.accounts.vault0.data.stored),
          },
        },
        "SOURCE_POOL_ACCOUNT_BYTES:vault1",
      ],
      [
        "recorded adapted pool",
        { source: { poolContext: (c) => (c.adaptedPool.baseDecimals = 9) } },
        "SOURCE_POOL_DIFFERS",
      ],
      ["missing ledger", { source: { omit: "ledger.json" } }, "SOURCE_NOT_LISTED:ledger.json"],
    ];
    for (const [label, opts, code] of cases) {
      const h = harness(opts);
      // The spec pins the base semantics; only the content (with consistent digests) differs.
      const err = await h.live().then(
        () => null,
        (e: unknown) => printableRetrospectiveError(e),
      );
      expect(err, label).toMatch(/^\[SOURCE_BINDING_REFUSED\] /);
      expect(err, label).toContain(code);
      expect(h.calls, label).toHaveLength(0);
      expect(h.loadCalls, label).toBe(0);
      expect(existsSync(h.outDir), label).toBe(false);
    }
    // The exchange digest is pinned in its own right.
    const h = harness();
    const bad = bindRetrospectiveSource(
      h.projectRoot,
      { ...h.spec, exchangeSha256: "1".repeat(64) },
      verifiers(h.spec).deps,
    );
    expect(bad).toEqual({ ok: false, problems: ["SOURCE_EXCHANGE_DIGEST"] });
    // With the real bundle verifiers, a synthetic (unsealed) source is refused.
    const real = bindRetrospectiveSource(h.projectRoot, h.spec);
    expect(real).toMatchObject({ ok: false, problems: ["SOURCE_ACQUISITION_NOT_VERIFIED"] });
    expect(
      bindRetrospectiveSource(
        h.projectRoot,
        { ...h.spec, signature: "abc" },
        verifiers(h.spec).deps,
      ),
    ).toEqual({
      ok: false,
      problems: ["SOURCE_SPEC_INVALID"],
    });
  });

  it("RT04: a bound synthetic v1 swap is analyzed, sealed, verified credential-free and never ingested", async () => {
    const h = harness();
    const r = await h.live();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(RPC_URL);
    expect(h.calls[0]!.body).toBe(cpmmGetTransactionRequestBody(SIG, 1, 1));
    expect(h.loadCalls).toBe(1);
    expect(r.exitCode).toBe(X.OK);
    expect(r.runFailures).toEqual([]);
    expect(r.seal).toMatchObject({ ok: true });
    const v = r.verification!;
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.sourceBinding).toEqual({ status: "VERIFIED", problems: [] });
    expect(v.computed).toMatchObject({
      replayStatus: "REPRODUCED",
      transportOutcome: "RESPONSE_RECEIVED",
      credentialScanRepeated: false,
    });
    expect(v.recorded!.analysis).toMatchObject({
      kind: "RESOLVED_SWAPS",
      payloadBound: true,
      versionComparison: "MATCHES_SOURCE_CLAIM",
      v1PayloadBound: true,
      decoderStatus: "SWAP_DECODED",
    });
    expect(v.computed!.classification).toEqual(v.recorded!.analysis);
    const record = readOut(h, RETRO_FILES.retrieval);
    expect(record).toMatchObject({
      classification: "RETROSPECTIVE_SUPPLEMENTAL",
      freshFlow: false,
      ingested: false,
    });
    expect(record.request).toMatchObject({
      owner: "SECURITY",
      purpose: "CPMM_RETROSPECTIVE_GET_TRANSACTION",
      lane: "SOLANA_RPC",
      jsonRpcId: 1,
      entry: {
        owner: "SECURITY",
        purpose: "CPMM_RETROSPECTIVE_GET_TRANSACTION",
        requestedIdentity: SIG,
      },
    });
    expect(record.recorded.httpAttempts).toBe(1);
    expect(record.recorded.analysis.events).toHaveLength(1);
    expect(record.recorded.analysis.events[0]).toMatchObject({
      side: "BUY",
      slot: SLOT,
      receiptTimestampMs: RECEIVED_AT,
      solAmount: "1000000000",
    });
    expect(record.timing).toEqual({
      startedAtMs: START_MS,
      deadlineAtMs: START_MS + 15_000,
      endedAtMs: expect.any(Number),
      cleanupGraceMs: 5_000,
    });
    expect(record.nonCertifications).toEqual(RETRO_NON_CERTIFICATIONS);
    expect(readOut(h, RETRO_FILES.sourceBinding).binding).toMatchObject({
      signature: SIG,
      sourceModified: false,
    });
    expect(readdirSync(h.outDir).sort()).toEqual([...Object.values(RETRO_FILES)].sort());
    expectNoSecrets(h);
    // The CLI's own --verify agrees.
    const again = await h.drive(
      runCpmmRetrospectiveTransactionCli(["--verify", OUT_REL], h.deps()),
    );
    expect(again.exitCode).toBe(X.OK);
    expect(h.logs).toContain(
      "[VERIFY] Computed replay: REPRODUCED; credential-aware scan repeated: no",
    );
  });

  it("RT05: the corrected outcome table: versions, failures, RPC errors and identity are kept distinct", async () => {
    const withSig = (s: string) => (id: number) =>
      JSON.stringify({ jsonrpc: "2.0", id, result: txResult(1, [swapIx()], s) });
    const failed = () => {
      const t = txResult(1);
      t.meta.err = { InstructionError: [0, { Custom: 6005 }] };
      return t;
    };
    const lookups = () => {
      const t = txResult(1);
      t.transaction.message.addressTableLookups = [];
      return t;
    };
    const cases: [string, (id: number) => string | Uint8Array, Loose, number][] = [
      [
        "legacy",
        rpcResult(txResult("legacy")),
        {
          kind: "RESOLVED_SWAPS",
          versionComparison: "DIFFERS_FROM_SOURCE_CLAIM",
          v1PayloadBound: false,
        },
        X.OK,
      ],
      [
        "v0",
        rpcResult(txResult(0)),
        {
          kind: "RESOLVED_SWAPS",
          versionComparison: "DIFFERS_FROM_SOURCE_CLAIM",
          v1PayloadBound: false,
        },
        X.OK,
      ],
      [
        "version 2",
        rpcResult(txResult(2)),
        {
          kind: "UNRESOLVED",
          code: "UNSUPPORTED_TRANSACTION_VERSION",
          versionComparison: "UNRESOLVED_VERSION_FIELD",
          v1PayloadBound: false,
        },
        X.OK,
      ],
      [
        "version missing",
        rpcResult(txResult(undefined)),
        {
          kind: "UNRESOLVED",
          code: "UNSUPPORTED_TRANSACTION_VERSION",
          versionComparison: "UNRESOLVED_VERSION_FIELD",
        },
        X.OK,
      ],
      [
        "version '1'",
        rpcResult(txResult("1")),
        {
          kind: "UNRESOLVED",
          versionComparison: "UNRESOLVED_VERSION_FIELD",
          v1PayloadBound: false,
        },
        X.OK,
      ],
      [
        "v1 refused by the decoder",
        rpcResult(lookups()),
        {
          kind: "UNRESOLVED",
          code: "MALFORMED_ACCOUNT_KEYS",
          detail: "V1_LOOKUPS",
          versionComparison: "MATCHES_SOURCE_CLAIM",
          v1PayloadBound: true,
        },
        X.OK,
      ],
      [
        "transaction failed",
        rpcResult(failed()),
        {
          kind: "RECORDED_FAILED_TRANSACTION",
          decoderStatus: "TRANSACTION_FAILED",
          versionComparison: "MATCHES_SOURCE_CLAIM",
        },
        X.OK,
      ],
      [
        "no target swap",
        rpcResult(txResult(1, [memoIx()])),
        { kind: "RESOLVED_NO_TARGET_SWAP", versionComparison: "MATCHES_SOURCE_CLAIM", events: [] },
        X.OK,
      ],
      [
        "-32015 under cap 1",
        (id) =>
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32015, message: ERROR_TEXT } }),
        {
          kind: "RPC_ERROR",
          code: "JSON_RPC_ERROR",
          rpcErrorCode: -32015,
          payloadBound: false,
          versionComparison: "NOT_COMPARED",
        },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "not found",
        rpcResult(null),
        { kind: "TRANSACTION_NOT_FOUND", code: "RESULT_NULL", versionComparison: "NOT_COMPARED" },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "slot mismatch",
        rpcResult(txResult(1, [swapIx()], SIG, SLOT + 1)),
        {
          kind: "METADATA_CONTRADICTION",
          code: "SLOT_MISMATCH",
          versionComparison: "NOT_COMPARED",
        },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "other signature",
        withSig(signatureOf(8)),
        {
          kind: "SIGNATURE_MISMATCH",
          code: "SIGNATURE_DIFFERENT",
          versionComparison: "NOT_COMPARED",
        },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "id mismatch",
        () => JSON.stringify({ jsonrpc: "2.0", id: 99, result: txResult(1) }),
        { kind: "MALFORMED_RESPONSE", code: "ID_MISMATCH" },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "extra envelope key",
        (id) => JSON.stringify({ jsonrpc: "2.0", id, result: txResult(1), extra: 1 }),
        { kind: "MALFORMED_RESPONSE", code: "ENVELOPE_EXTRA_KEY" },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "not JSON",
        () => "{not json",
        { kind: "MALFORMED_RESPONSE", code: "UNPARSABLE_JSON" },
        X.NO_TRANSACTION_PAYLOAD,
      ],
      [
        "not UTF-8",
        () => Uint8Array.from([0xff, 0xfe, 0x7b]),
        { kind: "MALFORMED_RESPONSE", code: "INVALID_UTF8" },
        X.NO_TRANSACTION_PAYLOAD,
      ],
    ];
    for (const [label, body, expected, exit] of cases) {
      const h = harness({ fetch: { body } });
      const r = await h.live();
      expect(h.calls, label).toHaveLength(1);
      expect(r.verification!.recorded!.analysis, label).toMatchObject(expected);
      expect(r.verification!.computed!.replayStatus, label).toBe("REPRODUCED");
      const recordedAnalysis = r.verification!.recorded!.analysis!;
      // The analyzer filters unrecognized decoder detail codes; the replay keeps the raw detail.
      const filtered = recordedAnalysis.detail === "UNRECOGNIZED_DECODER_DETAIL";
      expect(
        { ...r.verification!.computed!.classification!, ...(filtered ? { detail: null } : {}) },
        label,
      ).toEqual({ ...recordedAnalysis, ...(filtered ? { detail: null } : {}) });
      expect(r.exitCode, label).toBe(exit);
      expect(
        readOut(h, RETRO_FILES.retrieval).nonCertifications.decoderDefectEstablished,
        label,
      ).toBe(false);
      expectNoSecrets(h);
    }
  });

  it("RT06: redacted, withheld or incomplete bytes cannot establish exact replay", async () => {
    // A response carrying the credential: the analyzer withholds it; the sanitizer redacts it.
    const leaky = (id: number) => {
      const t = txResult(1);
      t.meta.logMessages.push(`Program log: ${RPC_URL}`);
      return JSON.stringify({ jsonrpc: "2.0", id, result: t });
    };
    const h = harness({ fetch: { body: leaky } });
    const r = await h.live();
    expect(r.verification!.recorded!.analysis).toMatchObject({
      kind: "EVIDENCE_NOT_REPLAYABLE",
      payloadBound: false,
    });
    expect(readOut(h, RETRO_FILES.retrieval).response.state).toMatch(/^(REDACTED|WITHHELD)$/);
    expect(r.verification!.computed!.replayStatus).toBe("UNAVAILABLE_CREDENTIAL_SCAN_NOT_REPEATED");
    expect(r.verification!.computed!.classification).toBeNull();
    expect(r.exitCode).toBe(X.EVIDENCE_LIMITED);
    expectNoSecrets(h);
    // Oversize: only a prefix was read; never analysed.
    const big = harness({ fetch: { body: () => " ".repeat(300_000) } });
    const rb = await big.live();
    expect(rb.acquisition!.outcome).toBe("RESPONSE_LIMIT_EXCEEDED");
    expect(rb.verification!.recorded!.analysis).toBeNull();
    expect(rb.verification!.computed!.replayStatus).toBe("REPRODUCED");
    expect(rb.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // A sealed ORIGINAL body changed to REDACTED (consistently) can no longer be replayed exactly.
    const h2 = harness();
    await h2.live();
    reseal(h2, RETRO_FILES.retrieval, (d) => {
      // A coherent redaction: the stored text differs from the original, digests updated.
      const redacted = (d.response.payload as string).replace(SIG, "[REDACTED]");
      const b = Buffer.from(redacted, "utf8");
      Object.assign(d.response, {
        state: "REDACTED",
        payloadRedacted: true,
        payload: redacted,
        storedBytes: b.length,
        storedSha256: sha(b),
      });
    });
    const v = verifyOut(h2);
    expect(v.integrity.ok).toBe(true);
    expect(v.computed!.replayStatus).toBe("UNAVAILABLE_REDACTED");
  });

  it("RT07: transport outcomes allow at most one request and never succeed", async () => {
    const cases: [string, FetchScript, string][] = [
      ["HTTP 500", { status: 500, body: () => "oops" }, "HTTP_ERROR"],
      ["network error", { throwError: `fetch failed ${RPC_URL}` }, "TRANSPORT_ERROR"],
      ["429", { status: 429, body: () => "slow down" }, "SESSION_STOPPED"],
      ["request timeout", { delayMs: 12_000 }, "DEADLINE_EXPIRED"],
    ];
    for (const [label, script, outcome] of cases) {
      const h = harness({ fetch: script });
      const r = await h.live();
      expect(h.calls, label).toHaveLength(1);
      expect(r.acquisition!.outcome, label).toBe(outcome);
      expect(r.verification!.integrity.ok, label).toBe(true);
      expect(r.verification!.computed!.replayStatus, label).toBe("REPRODUCED");
      expect(r.exitCode, label).toBe(X.NO_TRANSACTION_PAYLOAD);
      expectNoSecrets(h);
    }
  });

  it("RT08: one absolute 15 s deadline, a timeout capped by remaining time, and 5 s of settled cleanup", async () => {
    // The deadline starts before the session: 12 s already spent leaves a 3 s request timeout.
    const h = harness({ fetch: { delayMs: 4_000 } });
    let reads = 0;
    const late = () => (reads++ === 0 ? START_MS : Math.max(START_MS + 12_000, h.sched.now));
    const r = await h.live({ clock: late });
    expect(h.calls).toHaveLength(1);
    expect(r.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(r.acquisition!.endedAtMs).toBeLessThanOrEqual(START_MS + 15_000);
    expect(r.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // No time left: nothing is sent.
    const h0 = harness();
    let reads0 = 0;
    const expired = () => (reads0++ === 0 ? START_MS : START_MS + 15_000);
    const r0 = await h0.live({ clock: expired });
    expect(h0.calls).toHaveLength(0);
    expect(r0.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(r0.verification!.integrity.ok).toBe(true);
    expect(r0.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // The session races fetch against its own timeout; if those timers are lost and the request
    // ignores abort, the hard bound abandons it 5 s after the deadline: never a success.
    const hu = harness({ fetch: { delayMs: 60_000, ignoreAbort: true } });
    const lossy: PaperRequestSessionTimers = {
      setTimeout: (fn, ms) => (ms === 10_000 || ms === 15_000 ? -1 : hu.sched.add(fn, ms)),
      clearTimeout: (handle) => hu.sched.clear(handle),
    };
    const ru = await hu.drive(
      runCpmmRetrospectiveTransactionCli(
        ["--out-dir", OUT_REL, "--live"],
        hu.deps({ timers: lossy }),
      ),
      40_000,
    );
    expect(hu.calls).toHaveLength(1);
    expect(ru.acquisition!.outcome).toBe("CLEANUP_UNSETTLED");
    expect(ru.runFailures).toEqual(["CLEANUP_UNSETTLED"]);
    expect(ru.acquisition!.endedAtMs).toBe(START_MS + 15_000 + 5_000);
    // With working timers and a request that ignores abort, the session's own timeout settles it.
    const hs = harness({ fetch: { delayMs: 60_000, ignoreAbort: true } });
    const rs = await hs.live();
    expect(rs.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(rs.acquisition!.endedAtMs).toBe(START_MS + 10_000);
    expect(ru.verification!.integrity.ok).toBe(true);
    expect(ru.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
  });

  it("RT09: cancellation and invalid, regressing or throwing clocks prevent success through the final boundary", async () => {
    // Cancelled during the request.
    const hc = harness({ fetch: { delayMs: 1_000 } });
    const ac = new AbortController();
    hc.sched.add(() => ac.abort(), 200);
    const rc = await hc.live({ signal: ac.signal });
    expect(rc.acquisition!.outcome).toBe("OPERATOR_CANCELLED");
    expect(readOut(hc, RETRO_FILES.retrieval).recorded).toMatchObject({
      cancelled: true,
      cancellationPhase: "DURING_REQUEST",
    });
    expect(rc.exitCode).toBe(X.CANCELLED);
    // Cancelled after a good response, before sealing.
    const hb = harness();
    const ab = new AbortController();
    const rb = await hb.live({
      signal: ab.signal,
      log: (l) => {
        hb.logs.push(l);
        if (l.startsWith("[LIVE] Outcome:")) ab.abort();
      },
    });
    expect(rb.acquisition!.outcome).toBe("RESPONSE_RECEIVED");
    expect(readOut(hb, RETRO_FILES.retrieval).recorded).toMatchObject({
      cancellationPhase: "BEFORE_SEALING",
      runFailures: ["OPERATOR_CANCELLED"],
    });
    expect(rb.exitCode).toBe(X.CANCELLED);
    expect(retrospectiveVerifyExitCode(verifyOut(hb))).toBe(X.CANCELLED);
    // Cancelled after sealing and verification: the final decision still refuses success.
    const hf = harness();
    const af = new AbortController();
    const rf = await hf.live({
      signal: af.signal,
      log: (l) => {
        hf.logs.push(l);
        if (l.startsWith("[LIVE] Evidence sealed")) af.abort();
      },
    });
    expect(rf.verification!.computed!.replayStatus).toBe("REPRODUCED");
    expect(rf.runFailures).toEqual(["OPERATOR_CANCELLED"]);
    expect(rf.exitCode).toBe(X.CANCELLED);
    // A clock that regresses at the final boundary.
    const hr = harness();
    let regress = false;
    const rr = await hr.live({
      clock: () => (regress ? hr.sched.now - 1_000 : hr.sched.now),
      log: (l) => {
        hr.logs.push(l);
        if (l.startsWith("[LIVE] Evidence sealed")) regress = true;
      },
    });
    expect(rr.runFailures).toEqual(["CLOCK_FAILURE:CLOCK_REGRESSED"]);
    expect(rr.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // A clock that throws during the request: the request is stopped, nothing succeeds.
    const ht = harness({ fetch: { delayMs: 1_000 } });
    let throwing = false;
    ht.sched.add(() => (throwing = true), 300);
    const rt = await ht.live({
      clock: () => {
        if (throwing) throw new Error("clock broke");
        return ht.sched.now;
      },
    });
    // Nothing reads the clock while the request is in flight: the first failing read is at
    // completion. The transport facts stay as observed; the recorded run failure refuses success.
    expect(rt.runFailures![0]).toBe("CLOCK_FAILURE:CLOCK_THREW");
    expect(readOut(ht, RETRO_FILES.retrieval).recorded.runFailures).toEqual([
      "CLOCK_FAILURE:CLOCK_THREW",
    ]);
    expect(rt.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    expect(verifyOut(ht).recorded!.runFailures).toEqual(["CLOCK_FAILURE:CLOCK_THREW"]);
    // Offline verification of the sealed record refuses success on its own, too.
    expect(verifyOut(ht).computed!.replayStatus).toBe("REPRODUCED");
    expect(retrospectiveVerifyExitCode(verifyOut(ht))).toBe(X.NO_TRANSACTION_PAYLOAD);
    // A clock that throws before dispatch: nothing is sent.
    const hp = harness();
    let readsP = 0;
    const rp = await hp.live({
      clock: () => {
        if (readsP++ >= 1) throw new Error("clock broke");
        return hp.sched.now;
      },
    });
    expect(hp.calls).toHaveLength(0);
    expect(rp.acquisition!.outcome).toBe("CLOCK_FAILURE");
    expect(rp.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // An invalid clock at the start: nothing is sent.
    const hi = harness();
    const ri = await hi.live({ clock: () => Number.NaN });
    expect(hi.calls).toHaveLength(0);
    expect(ri.acquisition!.outcome).toBe("CLOCK_FAILURE");
    expect(ri.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // The earliest failure is preserved: cancellation, then a regressing clock.
    const he = harness({ fetch: { delayMs: 1_000 } });
    const ae = new AbortController();
    he.sched.add(() => ae.abort(), 100);
    let back = false;
    const re = await he.live({
      signal: ae.signal,
      clock: () => (back ? he.sched.now - 5 : he.sched.now),
      log: (l) => {
        he.logs.push(l);
        if (l.startsWith("[LIVE] Evidence sealed")) back = true;
      },
    });
    expect(re.runFailures).toEqual(["OPERATOR_CANCELLED", "CLOCK_FAILURE:CLOCK_REGRESSED"]);
    expect(re.exitCode).toBe(X.CANCELLED);
    // The guard itself: one failure recorded, later readings frozen at the last good value.
    const failures = createRetrospectiveRunFailures();
    let n = 10;
    const g = createRetrospectiveClock(() => n, failures);
    expect(g.now()).toBe(10);
    n = 9;
    expect(g.now()).toBe(10);
    n = 20;
    expect(g.now()).toBe(10);
    expect(failures.list).toEqual(["CLOCK_FAILURE:CLOCK_REGRESSED"]);
  });

  it("RT10: verification keeps integrity, source binding, recorded and computed results apart", async () => {
    const h = harness();
    await h.live();
    expect(verifyOut(h).computed!.replayStatus).toBe("REPRODUCED");
    // A consistently rewritten recorded classification is a replay mismatch (exit 4).
    const tampered = harness();
    await tampered.live();
    reseal(tampered, RETRO_FILES.retrieval, (d) => {
      d.recorded.analysis.kind = "RESOLVED_NO_TARGET_SWAP";
      d.recorded.analysis.events = [];
    });
    const vt = verifyOut(tampered);
    expect(vt.integrity.ok).toBe(true);
    expect(vt.computed!.replayStatus).toBe("MISMATCH");
    expect(vt.recorded!.analysis!.kind).toBe("RESOLVED_NO_TARGET_SWAP");
    expect(vt.computed!.classification!.kind).toBe("RESOLVED_SWAPS");
    // Integrity failures.
    const integrity: [string, (h: ReturnType<typeof harness>) => void, string][] = [
      [
        "byte change",
        (x) => writeFileSync(path.join(x.outDir, RETRO_FILES.plan), "{}\n"),
        "MODIFIED:plan.json",
      ],
      [
        "unlisted file",
        (x) => writeFileSync(path.join(x.outDir, "extra.json"), "{}"),
        "UNLISTED:extra.json",
      ],
      [
        "plan mode",
        (x) => reseal(x, RETRO_FILES.plan, (d) => (d.mode = "DRY_RUN")),
        "PLAN_INVALID",
      ],
      [
        "source record",
        (x) => reseal(x, RETRO_FILES.sourceBinding, (d) => (d.binding.versionClaim = 0)),
        "SOURCE_BINDING_RECORD_INVALID",
      ],
      [
        "fresh flow",
        (x) => reseal(x, RETRO_FILES.retrieval, (d) => (d.freshFlow = true)),
        "RECORD_INVALID",
      ],
      [
        "cap-0 request",
        (x) =>
          reseal(
            x,
            RETRO_FILES.retrieval,
            (d) => (d.request.body = cpmmGetTransactionRequestBody(SIG, 1, 0)),
          ),
        "REQUEST_EVIDENCE_INVALID",
      ],
      [
        "flow owner",
        (x) => reseal(x, RETRO_FILES.retrieval, (d) => (d.request.owner = "FLOW")),
        "REQUEST_EVIDENCE_INVALID",
      ],
      [
        "two attempts",
        (x) => reseal(x, RETRO_FILES.retrieval, (d) => (d.recorded.httpAttempts = 2)),
        "REQUEST_EVIDENCE_INVALID",
      ],
      [
        "deadline",
        (x) => reseal(x, RETRO_FILES.retrieval, (d) => (d.timing.deadlineAtMs += 1)),
        "TIMING_INVALID",
      ],
      [
        "response dropped from an exchange outcome",
        (x) =>
          reseal(x, RETRO_FILES.retrieval, (d) => {
            // Coherent in every other respect: zero attempts, no id, body or times.
            d.response = null;
            d.request.entry = null;
            d.request.jsonRpcId = null;
            d.request.body = null;
            d.request.dispatchedAtMs = null;
            d.request.completedAtMs = null;
            d.recorded.httpAttempts = 0;
            d.recorded.analysis = null;
            d.recorded.outcome = "HTTP_ERROR";
          }),
        "RESPONSE_ACCOUNTING_INVALID",
      ],
    ];
    for (const [label, mutate, problem] of integrity) {
      const x = harness();
      await x.live();
      mutate(x);
      const v = verifyOut(x);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain(problem);
      expect(v.computed, label).toBeNull();
    }
    // The source no longer binds at verification time: a failed binding, never a reproduction.
    const s = harness();
    await s.live();
    const vs = verifyOut(s, verifiers(s.spec, { obs: { integrity: { ok: false } } }).deps);
    expect(vs.integrity.ok).toBe(true);
    expect(vs.sourceBinding).toEqual({
      status: "FAILED",
      problems: ["SOURCE_OBSERVATION_NOT_VERIFIED"],
    });
    expect(vs.computed!.replayStatus).toBe("UNAVAILABLE_SOURCE_NOT_BOUND");
    const cli = await s.drive(
      runCpmmRetrospectiveTransactionCli(
        ["--verify", OUT_REL],
        s.deps({ sourceDeps: verifiers(s.spec, { obs: { integrity: { ok: false } } }).deps }),
      ),
    );
    expect(cli.exitCode).toBe(X.INTEGRITY_FAILED);
  });

  it("RT11: sealing is exclusive; a write failure keeps no manifest and is never retried", async () => {
    const h = harness();
    let writes = 0;
    const r = await h.live({
      writeFile: (f, c, o) => {
        writes++;
        if (path.basename(f) === RETRO_FILES.retrieval) throw new Error(`disk full ${RPC_URL}`);
        writeFileSync(f, c, o);
      },
    });
    expect(r.seal).toMatchObject({ ok: false, status: "ARTIFACT_WRITE_FAILED" });
    expect(r.exitCode).toBe(X.SEAL_FAILED);
    expect(writes).toBe(3);
    expect(existsSync(path.join(h.outDir, RETRO_FILES.manifest))).toBe(false);
    expect(h.calls).toHaveLength(1);
    expectNoSecrets(h);
  });
});

// ---------------------------------------------------------------------------------------------
// Review regressions on 989190d (synthetic): listener cleanup, response accounting, timing
// ---------------------------------------------------------------------------------------------

describe("cpmm-retrospective-transaction review regressions (synthetic, offline)", () => {
  it("RR1: listener cleanup that cancels or breaks the clock still prevents success", async () => {
    // removeListener aborts the external AbortController.
    const ha = harness();
    const ext = new AbortController();
    const ra = await ha.live({
      signal: ext.signal,
      signals: { on: () => undefined, removeListener: () => ext.abort() },
    });
    expect(ra.runFailures).toEqual(["OPERATOR_CANCELLED"]);
    expect(ra.exitCode).toBe(X.CANCELLED);
    // removeListener makes the injected clock return NaN.
    const hn = harness();
    let broken = false;
    const rn = await hn.live({
      clock: () => (broken ? Number.NaN : hn.sched.now),
      signals: {
        on: () => undefined,
        removeListener: () => {
          broken = true;
        },
      },
    });
    expect(rn.runFailures).toEqual(["CLOCK_FAILURE:CLOCK_INVALID"]);
    expect(rn.exitCode).toBe(X.NO_TRANSACTION_PAYLOAD);
    // Earlier failures are preserved: cancelled during the request, then the clock breaks in cleanup.
    const he = harness({ fetch: { delayMs: 1_000 } });
    const ae = new AbortController();
    he.sched.add(() => ae.abort(), 100);
    let later = false;
    const re = await he.live({
      signal: ae.signal,
      clock: () => (later ? Number.NaN : he.sched.now),
      signals: {
        on: () => undefined,
        removeListener: () => {
          later = true;
        },
      },
    });
    expect(re.runFailures).toEqual(["OPERATOR_CANCELLED", "CLOCK_FAILURE:CLOCK_INVALID"]);
    expect(re.exitCode).toBe(X.CANCELLED);
    // Legitimate cleanup: listeners attached once and removed once; a failed removal is reported.
    const hl = harness();
    const added: string[] = [];
    const removed: string[] = [];
    const rl = await hl.live({
      signals: { on: (s) => added.push(s), removeListener: (s) => removed.push(s) },
    });
    expect(added).toEqual(["SIGINT", "SIGTERM"]);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
    expect(rl.exitCode).toBe(X.OK);
    const hf = harness();
    const rf = await hf.live({
      signals: {
        on: () => undefined,
        removeListener: () => {
          throw new Error("cannot remove");
        },
      },
    });
    expect(rf.signalCleanupFailures).toEqual([
      "SIGNAL_REMOVE_FAILED:SIGINT",
      "SIGNAL_REMOVE_FAILED:SIGTERM",
    ]);
    expect(rf.runFailures).toEqual([]);
    expect(rf.exitCode).toBe(X.CLEANUP_FAILED);
  });

  it("RR2: response byte counts and body state must match the accepted bounded reader", async () => {
    // Unused JSON padding: a complete response beyond the 262,144-byte cap.
    const hp = harness();
    await hp.live();
    reseal(hp, RETRO_FILES.retrieval, (d) => {
      const body = d.response.payload as string;
      const padded = body + " ".repeat(264_370 - Buffer.byteLength(body));
      const b = Buffer.from(padded, "utf8");
      expect(b.length).toBe(264_370);
      Object.assign(d.response, {
        payload: padded,
        storedBytes: b.length,
        storedSha256: sha(b),
        originalBytes: b.length,
        originalSha256: sha(b),
        observedBytes: b.length,
      });
    });
    const vp = verifyOut(hp);
    expect(vp.integrity.ok).toBe(false);
    expect(vp.integrity.problems).toContain("RESPONSE_ACCOUNTING_INVALID");
    expect(retrospectiveVerifyExitCode(vp)).toBe(X.INTEGRITY_FAILED);
    // The original body, but zero observed bytes.
    const ho = harness();
    await ho.live();
    reseal(ho, RETRO_FILES.retrieval, (d) => {
      expect(d.response.originalBytes).toBeGreaterThan(0);
      d.response.observedBytes = 0;
    });
    const vo = verifyOut(ho);
    expect(vo.integrity.problems).toContain("RESPONSE_ACCOUNTING_INVALID");
    expect(retrospectiveVerifyExitCode(vo)).toBe(X.INTEGRITY_FAILED);
    // Further incoherent states.
    const forged: [string, (d: Loose) => void][] = [
      ["complete body marked incomplete", (d) => (d.request.entry.bodyComplete = false)],
      ["unknown body state", (d) => (d.response.bodyState = "TRUNCATED")],
      ["overflow without an oversize error", (d) => (d.response.bodyState = "PARTIAL_OVERFLOW")],
      ["not-read with stored bytes", (d) => (d.response.bodyState = "NOT_READ")],
      ["complete body with a session error", (d) => (d.request.error = "NETWORK_ERROR")],
      ["response limit changed", (d) => (d.response.maxResponseBytes = 300_000)],
      ["original bytes differ from stored", (d) => (d.response.originalBytes += 1)],
      ["redaction flag on original bytes", (d) => (d.response.payloadRedacted = true)],
      [
        "redacted bytes identical to the original",
        (d) => Object.assign(d.response, { state: "REDACTED", payloadRedacted: true }),
      ],
      [
        "overflow without observed excess",
        (d) => {
          // Coherent overflow in every respect except the observed byte count.
          d.response.bodyState = "PARTIAL_OVERFLOW";
          d.response.observedBytes = d.response.originalBytes;
          d.request.error = "RESPONSE_TOO_LARGE";
          d.request.entry.bodyComplete = false;
          d.recorded.analysis = null;
          d.recorded.outcome = "RESPONSE_LIMIT_EXCEEDED";
        },
      ],
    ];
    for (const [label, mutate] of forged) {
      const x = harness();
      await x.live();
      reseal(x, RETRO_FILES.retrieval, mutate);
      const v = verifyOut(x);
      expect(v.integrity.ok, label).toBe(false);
      expect(retrospectiveVerifyExitCode(v), label).toBe(X.INTEGRITY_FAILED);
    }
    // Legitimate accounting still verifies: empty, oversized prefix, not read, redacted or withheld.
    const leaky = (id: number) => {
      const t = txResult(1);
      t.meta.logMessages.push(`Program log: ${RPC_URL}`);
      return JSON.stringify({ jsonrpc: "2.0", id, result: t });
    };
    const legit: [string, FetchScript][] = [
      ["empty body", { body: () => "" }],
      ["oversized prefix", { body: () => " ".repeat(300_000) }],
      ["not read (429)", { status: 429, body: () => "slow" }],
      ["not read (timeout)", { delayMs: 12_000 }],
      ["credential in body", { body: leaky }],
    ];
    for (const [label, script] of legit) {
      const x = harness({ fetch: script });
      const r = await x.live();
      expect(r.verification!.integrity, label).toEqual({ ok: true, problems: [] });
    }
  });

  it("RR3: dispatch strictly before the deadline, coherent ordering, and attempts matching the evidence", async () => {
    // Dispatch and completion at the deadline, ended at the deadline.
    const hd = harness();
    await hd.live();
    reseal(hd, RETRO_FILES.retrieval, (d) => {
      d.request.dispatchedAtMs = d.timing.deadlineAtMs;
      d.request.completedAtMs = d.timing.deadlineAtMs;
      d.timing.endedAtMs = d.timing.deadlineAtMs;
    });
    const vd = verifyOut(hd);
    expect(vd.integrity.ok).toBe(false);
    expect(vd.integrity.problems).toContain("DISPATCH_AT_OR_AFTER_DEADLINE");
    expect(retrospectiveVerifyExitCode(vd)).toBe(X.INTEGRITY_FAILED);
    const forged: [string, (d: Loose) => void, string][] = [
      [
        "dispatch before start",
        (d) => (d.request.dispatchedAtMs = d.timing.startedAtMs - 1),
        "TIMING_ORDER_INVALID",
      ],
      [
        "completion before dispatch",
        (d) => (d.request.completedAtMs = d.request.dispatchedAtMs - 1),
        "TIMING_ORDER_INVALID",
      ],
      [
        "end before completion",
        (d) => (d.timing.endedAtMs = d.request.completedAtMs - 1),
        "TIMING_ORDER_INVALID",
      ],
      [
        "end beyond the cleanup bound",
        (d) => (d.timing.endedAtMs = d.timing.deadlineAtMs + 5_001),
        "TIMING_ORDER_INVALID",
      ],
      ["missing completion", (d) => (d.request.completedAtMs = null), "TIMING_ORDER_INVALID"],
      [
        "exchange with zero attempts",
        (d) => (d.recorded.httpAttempts = 0),
        "ATTEMPTS_INCONSISTENT",
      ],
      [
        "no exchange but one attempt",
        (d) => {
          d.response = null;
          d.request.entry = null;
          d.request.dispatchedAtMs = null;
          d.request.completedAtMs = null;
          d.recorded.analysis = null;
          d.recorded.outcome = "NOT_DISPATCHED";
        },
        "ATTEMPTS_INCONSISTENT",
      ],
      ["entry without response", (d) => (d.response = null), "RESPONSE_ACCOUNTING_INVALID"],
    ];
    for (const [label, mutate, problem] of forged) {
      const x = harness();
      await x.live();
      reseal(x, RETRO_FILES.retrieval, mutate);
      const v = verifyOut(x);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain(problem);
    }
    // Legitimate records still verify: timeout, cancellation, pre-dispatch refusal, unsettled.
    const timeout = harness({ fetch: { delayMs: 12_000 } });
    expect((await timeout.live()).verification!.integrity.ok).toBe(true);
    const cancel = harness({ fetch: { delayMs: 1_000 } });
    const ac = new AbortController();
    cancel.sched.add(() => ac.abort(), 200);
    expect((await cancel.live({ signal: ac.signal })).verification!.integrity.ok).toBe(true);
    const pre = harness();
    let reads = 0;
    const rp = await pre.live({ clock: () => (reads++ === 0 ? START_MS : START_MS + 15_000) });
    expect(pre.calls).toHaveLength(0);
    expect(rp.verification!.integrity.ok).toBe(true);
    expect(readOut(pre, RETRO_FILES.retrieval).request).toMatchObject({
      jsonRpcId: null,
      body: null,
      dispatchedAtMs: null,
      entry: null,
    });
    const cancelledFirst = harness();
    const ab = new AbortController();
    ab.abort();
    const rc = await cancelledFirst.live({ signal: ab.signal });
    expect(cancelledFirst.calls).toHaveLength(0);
    expect(rc.verification!.integrity.ok).toBe(true);
    expect(rc.exitCode).toBe(X.CANCELLED);
    const hu = harness({ fetch: { delayMs: 60_000, ignoreAbort: true } });
    const lossy: PaperRequestSessionTimers = {
      setTimeout: (fn, ms) => (ms === 10_000 || ms === 15_000 ? -1 : hu.sched.add(fn, ms)),
      clearTimeout: (handle) => hu.sched.clear(handle),
    };
    const ru = await hu.drive(
      runCpmmRetrospectiveTransactionCli(
        ["--out-dir", OUT_REL, "--live"],
        hu.deps({ timers: lossy }),
      ),
      40_000,
    );
    expect(ru.acquisition!.outcome).toBe("CLEANUP_UNSETTLED");
    expect(ru.verification!.integrity.ok).toBe(true);
    expect(readOut(hu, RETRO_FILES.retrieval).recorded.httpAttempts).toBe(1);
  });
});
