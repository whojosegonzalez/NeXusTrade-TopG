/**
 * PAPER single-candidate operator diagnostic (offline): strict market parser, dry-run boundary,
 * argument and output refusals, and mocked live runs through the accepted coordinator on the shared
 * virtual scheduler. Every response, key and value is SYNTHETIC; no real network, socket or daemon.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_EVIDENCE_FILES,
  LIVE_APPROVAL_STATUS,
  PROPOSED_SINGLE_CANDIDATE_LIMITS,
  buildRequestAllocation,
  runPaperSingleCandidateDiagnostic,
  runVerifyCli,
  verifyPaperSingleCandidateEvidence,
  type PaperSingleCandidateDiagnosticDeps,
} from "./paper-single-candidate-diagnostic.js";
import { decodeRaydiumTransactionSwaps } from "../candidate-scanner/RaydiumAmmV4SwapDecoder.js";
import { WSOL_MINT, parseRaydiumAmmV4Account } from "../research/pilot/RaydiumAmmParser.js";
import {
  parseDexScreenerTokenPairs,
  WSOL_MINT_ADDRESS,
} from "../candidate-scanner/DexScreenerSingleCandidateMarketParser.js";
import type { PaperCoordinatorLimits } from "../candidate-scanner/PaperSingleCandidateCoordinator.js";
import {
  MINT,
  OFFLINE_TEST_LIMITS,
  POOL_CONTEXT,
  POOL_ID,
  START_MS,
  TEST_RPC_URL,
  createHarness,
  drive,
  sig,
} from "../candidate-scanner/PaperRollingCandidateFlowProvider.test-support.js";
import { SYNTHETIC_QUALIFIED_RAW_PAYLOAD } from "../candidate-scanner/fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  syntheticMintAccountResponse,
  syntheticRugCheckReport,
  syntheticSolanaTrackerBundlersPayload,
} from "../candidate-scanner/fixtures/SyntheticPaperSecurityEvidenceFixture.js";
import {
  syntheticDexScreenerPair,
  syntheticDexScreenerTokenPairsResponse,
} from "../candidate-scanner/fixtures/SanitizedDexScreenerTokenPairsFixture.js";

const tempRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TARGET = { poolId: POOL_ID, mintAddress: MINT };
/** SYNTHETIC fixed pool creation time: about 600 s old at the 67 s intake. */
const PAIR_CREATED_AT_MS = START_MS + 67_000 - 600_000;
const SYNTHETIC_RPC_KEY = "SYNTHETIC-RPC-KEY-1234567890";
const SYNTHETIC_TRACKER_KEY = "SYNTHETIC-TRACKER-KEY-0000";
const ENV = Object.freeze({
  SOLANA_RPC_URL: `${TEST_RPC_URL}/?api-key=${SYNTHETIC_RPC_KEY}`,
  SOLANA_TRACKER_API_KEY: SYNTHETIC_TRACKER_KEY,
});
const ACTIVE_SWAPS = [
  { signature: sig(61), atMs: 45_000, side: "BUY" as const },
  { signature: sig(62), atMs: 50_000, side: "BUY" as const },
  { signature: sig(63), atMs: 55_000, side: "SELL" as const },
];
/** OFFLINE TEST CONFIGURATION ONLY (shorter lifetime than the proposal; not approved). */
const TEST_LIMITS: PaperCoordinatorLimits = {
  ...PROPOSED_SINGLE_CANDIDATE_LIMITS,
  session: { ...PROPOSED_SINGLE_CANDIDATE_LIMITS.session, lifetimeMs: 150_000 },
  flow: { ...OFFLINE_TEST_LIMITS, lifetimeMs: 150_000, maxResponseBytes: 262_144 },
  schedule: { ...PROPOSED_SINGLE_CANDIDATE_LIMITS.schedule, decisionLeadMs: 500 },
};

function tempProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "topg-single-candidate-"));
  tempRoots.push(root);
  return root;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Mocked transports and virtual time for one runner invocation. */
function liveEnv(
  o: {
    readonly market?: (call: number) => Response;
    readonly rugCheck?: () => Response;
    readonly limits?: PaperCoordinatorLimits;
  } = {},
) {
  let marketCalls = 0;
  const h = createHarness({
    swaps: ACTIVE_SWAPS,
    rpcResult: (method, params) => {
      if (method === "getAccountInfo" && params[0] === MINT) {
        return { result: (syntheticMintAccountResponse() as { result: unknown }).result };
      }
      if (method === "getMultipleAccounts") {
        return { result: (SYNTHETIC_QUALIFIED_RAW_PAYLOAD as { result: unknown }).result };
      }
      return undefined;
    },
    otherHttp: ({ path: p }) => {
      if (p === `/v1/tokens/${MINT}/report`)
        return o.rugCheck?.() ?? json(syntheticRugCheckReport());
      if (p === `/tokens/${MINT}/bundlers`) return json(syntheticSolanaTrackerBundlersPayload());
      if (p === `/latest/dex/tokens/${MINT}`) {
        marketCalls++;
        if (o.market) return o.market(marketCalls);
        // SYNTHETIC: intake and the arming decision at the peak; a 12% pullback afterwards.
        return json(
          syntheticDexScreenerTokenPairsResponse({
            pairCreatedAtMs: PAIR_CREATED_AT_MS,
            priceNative: marketCalls <= 2 ? "0.0001" : "0.000088",
          }),
        );
      }
      return undefined;
    },
  });
  const root = tempProject();
  const lines: string[] = [];
  const loadEnvironment = vi.fn();
  const createWs = vi.fn(() => h.createWebSocketTransport());
  const deps: PaperSingleCandidateDiagnosticDeps = {
    env: ENV,
    loadEnvironment,
    fetchFn: h.fetchFn,
    createWebSocketTransport: createWs,
    clock: h.clock,
    timers: h.timers,
    projectRoot: root,
    limits: o.limits ?? TEST_LIMITS,
    log: (line) => lines.push(line),
  };
  return { h, root, deps, lines, loadEnvironment, createWs };
}

const outArgs = (name: string) => [
  "--pool",
  POOL_ID,
  "--mint",
  MINT,
  "--out-dir",
  `data/research/single-candidate/${name}`,
];
const readJson = (dir: string, file: string) =>
  JSON.parse(readFileSync(path.join(dir, file), "utf8"));

/** The credential-bearing WebSocket URL derived from the SYNTHETIC RPC URL. */
const SYNTHETIC_WS_URL = ENV.SOLANA_RPC_URL.replace(/^http:/, "ws:");
const SECRETS = [SYNTHETIC_RPC_KEY, SYNTHETIC_TRACKER_KEY, ENV.SOLANA_RPC_URL, SYNTHETIC_WS_URL];

/** Every file in a directory tree (relative, forward-slashed). */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((name) => {
    const child = rel ? `${rel}/${name}` : name;
    return statSync(path.join(dir, child)).isDirectory() ? filesUnder(dir, child) : [child];
  });
}

/** No secret anywhere in the sealed directory, including response-evidence subdirectories. */
function expectNoSecrets(dir: string) {
  for (const name of filesUnder(dir)) {
    const content = readFileSync(path.join(dir, name), "utf8");
    for (const secret of SECRETS) {
      expect(content.includes(secret), `${name} contains a secret`).toBe(false);
    }
  }
}

/** Parsed JSON from sealed files (shape checked by the assertions). */
type Loose = ReturnType<typeof JSON.parse>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** SYNTHETIC: market at the peak for `peakCalls` calls, then a 12% pullback. */
const peakThenPullback = (peakCalls: number) => (call: number) =>
  json(
    syntheticDexScreenerTokenPairsResponse({
      pairCreatedAtMs: PAIR_CREATED_AT_MS,
      priceNative: call <= peakCalls ? "0.0001" : "0.000088",
    }),
  );

interface SealedExchange {
  seq: number;
  lane: string;
  owner: string;
  purpose: string;
  jsonRpcId: number | null;
  httpStatus: number | null;
  error: string | null;
  request: { url: string; rpcMethod: string | null; rpcParams: unknown[] | null };
  response: {
    bodyState: string;
    completeEvidence: boolean;
    retainedBytes: number | null;
    observedBytes: number | null;
    receivedBytesSha256: string | null;
    receivedDigestScope: string | null;
    reproducesReceivedDigest: boolean;
    bodyRedacted: boolean;
    bodyEncoding: string | null;
    body: string | null;
  };
}

const sealedExchanges = (dir: string): SealedExchange[] =>
  (readJson(dir, "request-exchanges.json").exchanges as { file: string }[]).map(
    (x) => readJson(dir, x.file) as SealedExchange,
  );

/** A copy of a sealed run, with its manifest optionally rewritten (for verifier tests). */
function tamperedCopy(
  source: string,
  name: string,
  edit?: (manifest: Record<string, Loose>) => void,
): string {
  const dir = path.join(tempProject(), name);
  cpSync(source, dir, { recursive: true });
  if (edit) {
    const manifest = readJson(dir, "evidence-manifest.json");
    edit(manifest);
    writeFileSync(path.join(dir, "evidence-manifest.json"), JSON.stringify(manifest));
  }
  return dir;
}

describe("DexScreener single-candidate market parser (synthetic, schema-shaped fixture)", () => {
  it("P-01: selects only the exact Raydium pool with the candidate base and WSOL quote; preserves units and creation time", () => {
    const response = syntheticDexScreenerTokenPairsResponse({
      pairCreatedAtMs: PAIR_CREATED_AT_MS,
    });
    const r = parseDexScreenerTokenPairs(response, TARGET, START_MS + 67_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pool).toMatchObject({
      poolId: POOL_ID,
      mintAddress: MINT,
      baseMint: MINT,
      liquidityUsd: 65_000,
      marketCapUsd: 250_000,
      openTimeSec: Math.floor(PAIR_CREATED_AT_MS / 1000),
      lpBurnPct: null,
      mintAuthority: "UNVERIFIED_AUTHORITY",
      freezeAuthority: "UNVERIFIED_AUTHORITY",
      volume5mUsd: 15_000,
      buys5m: 40,
      sells5m: 15,
      txCount5m: 55,
      spotPriceSol: 0.0001,
      spotPriceUsd: 0.015,
    });
    expect(r.spot).toEqual({
      spotPriceSol: 0.0001,
      spotPriceUsd: 0.015,
      liquidityUsd: 65_000,
      momentum5mBps: 0,
      priceChange1hPct: 4.2,
    });
    expect(r.provenance).toMatchObject({
      pairAddress: POOL_ID,
      orientation: "TOKEN_BASE_WSOL_QUOTE",
      priceUnits: { priceNative: "SOL_PER_TOKEN", priceUsd: "USD_PER_TOKEN" },
      creation: { pairCreatedAtMs: PAIR_CREATED_AT_MS, source: "DEXSCREENER_PAIR_CREATED_AT" },
    });
    expect(r.provenance.classifications).toMatchObject({
      lpBurnPct: "UNAVAILABLE",
      mintAuthority: "UNAVAILABLE",
      decimals: "UNAVAILABLE",
    });

    // Optional price changes stay absent and are classified UNAVAILABLE; nothing is defaulted.
    const noChange = parseDexScreenerTokenPairs(
      {
        pairs: [
          syntheticDexScreenerPair({ pairCreatedAtMs: PAIR_CREATED_AT_MS }, { priceChange: {} }),
        ],
      },
      TARGET,
    );
    expect(noChange.ok && noChange.spot).toEqual({
      spotPriceSol: 0.0001,
      spotPriceUsd: 0.015,
      liquidityUsd: 65_000,
    });
    expect(noChange.ok && noChange.provenance.classifications.priceChangeH1).toBe("UNAVAILABLE");
  });

  it("P-02: rejects unsupported, mismatched and malformed inputs instead of inventing metrics", () => {
    const pair = (overrides: Record<string, unknown>) => ({
      pairs: [syntheticDexScreenerPair({ pairCreatedAtMs: PAIR_CREATED_AT_MS }, overrides)],
    });
    const exact = syntheticDexScreenerPair({ pairCreatedAtMs: PAIR_CREATED_AT_MS });
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["not an object", "pairs", "MALFORMED_RESPONSE"],
      ["pairs not an array", { pairs: {} }, "MALFORMED_RESPONSE"],
      ["no pairs", { pairs: [] }, "NO_PAIRS"],
      [
        "only decoys",
        { pairs: syntheticDexScreenerTokenPairsResponse({ pairCreatedAtMs: 1 }).pairs.slice(1) },
        "POOL_NOT_FOUND",
      ],
      ["prefixed pool id", pair({ pairAddress: `dexscreener-${POOL_ID}` }), "POOL_NOT_FOUND"],
      ["duplicate pool", { pairs: [exact, exact] }, "AMBIGUOUS_POOL"],
      ["other chain", pair({ chainId: "ethereum" }), "CHAIN_NOT_SOLANA"],
      ["other dex", pair({ dexId: "orca" }), "DEX_NOT_RAYDIUM"],
      ["Raydium CLMM", pair({ labels: ["CLMM"] }), "UNSUPPORTED_RAYDIUM_POOL_TYPE"],
      ["Raydium CPMM", pair({ labels: ["CPMM"] }), "UNSUPPORTED_RAYDIUM_POOL_TYPE"],
      [
        "WSOL base, candidate quote",
        pair({
          baseToken: { address: WSOL_MINT_ADDRESS, symbol: "SOL" },
          quoteToken: { address: MINT, symbol: "RAY" },
        }),
        "UNSUPPORTED_ORIENTATION",
      ],
      [
        "other base mint",
        pair({ baseToken: { address: WSOL_MINT_ADDRESS.replace("2", "3"), symbol: "X" } }),
        "BASE_MINT_MISMATCH",
      ],
      [
        "SOL symbol, wrong address",
        pair({ quoteToken: { address: POOL_ID, symbol: "SOL" } }),
        "QUOTE_NOT_WSOL",
      ],
      ["missing symbol", pair({ baseToken: { address: MINT } }), "SYMBOL_UNAVAILABLE"],
      ["zero price", pair({ priceNative: "0" }), "PRICE_NATIVE_INVALID"],
      ["non-numeric price", pair({ priceNative: "abc" }), "PRICE_NATIVE_INVALID"],
      ["numeric (not string) price", pair({ priceNative: 0.0001 }), "PRICE_NATIVE_INVALID"],
      ["missing USD price", pair({ priceUsd: undefined }), "PRICE_USD_INVALID"],
      ["missing liquidity", pair({ liquidity: {} }), "LIQUIDITY_UNAVAILABLE"],
      [
        "missing market cap (fdv not substituted)",
        pair({ marketCap: undefined }),
        "MARKET_CAP_UNAVAILABLE",
      ],
      ["missing creation time", pair({ pairCreatedAt: undefined }), "CREATION_TIME_UNAVAILABLE"],
      ["missing m5 txns", pair({ txns: { h1: { buys: 1, sells: 1 } } }), "M5_TXNS_UNAVAILABLE"],
      [
        "fractional m5 buys",
        pair({ txns: { m5: { buys: 1.5, sells: 1 } } }),
        "M5_TXNS_UNAVAILABLE",
      ],
      ["missing m5 volume", pair({ volume: { h1: 1 } }), "M5_VOLUME_UNAVAILABLE"],
    ];
    for (const [label, input, reason] of cases) {
      const r = parseDexScreenerTokenPairs(input, TARGET);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason, label).toBe(reason);
    }
  });
});

describe("PAPER single-candidate operator diagnostic (offline)", () => {
  it("D-01: the default dry run validates and prints the full plan with zero dispatch and nothing written", async () => {
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no network in tests"));
    const env = liveEnv();
    const fetchSpy = vi.fn(env.deps.fetchFn!);
    const result = await runPaperSingleCandidateDiagnostic(outArgs("dry-1"), {
      ...env.deps,
      fetchFn: fetchSpy,
    });
    expect(result.mode).toBe("DRY_RUN");
    expect(result.plan.approval).toBe(LIVE_APPROVAL_STATUS);
    expect(result.plan.target).toEqual(TARGET);
    expect(env.lines.some((l) => l.includes(result.planDigestSha256))).toBe(true);
    expect(
      env.lines.some((l) => l.includes('"kind": "PAPER_SINGLE_CANDIDATE_DIAGNOSTIC_PLAN"')),
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(env.createWs).not.toHaveBeenCalled();
    expect(env.loadEnvironment).not.toHaveBeenCalled();
    expect(env.h.sched.count("provider")).toBe(0);
    expect(readdirSync(env.root)).toEqual([]); // nothing created, not even the evidence root

    // The proposed allocation is complete and fits every lane and the session ceiling.
    const allocation = buildRequestAllocation(PROPOSED_SINGLE_CANDIDATE_LIMITS);
    expect(allocation).toMatchObject({
      solanaRpc: { flow: 300, security: 18, total: 318, laneCeiling: 320, reconnectAllowance: 1 },
      rugCheck: { total: 6, laneCeiling: 6 },
      solanaTracker: { total: 6, laneCeiling: 6 },
      market: { intake: 1, decisions: 8, total: 9, laneCeiling: 9 },
      total: 339,
      sessionCeiling: 340,
    });
    expect(() =>
      buildRequestAllocation({
        ...PROPOSED_SINGLE_CANDIDATE_LIMITS,
        schedule: { ...PROPOSED_SINGLE_CANDIDATE_LIMITS.schedule, maxDecisions: 9 },
      }),
    ).toThrow(/market lane/);
  });

  it("D-02: arguments, output directories and missing configuration are refused before any dispatch", async () => {
    const env = liveEnv();
    const fetchSpy = vi.fn(env.deps.fetchFn!);
    const deps = { ...env.deps, fetchFn: fetchSpy };
    const bad: readonly (readonly [string, string[], RegExp])[] = [
      ["missing pool", ["--mint", MINT, "--out-dir", "data/research/single-candidate/x"], /--pool/],
      [
        "non-canonical mint",
        ["--pool", POOL_ID, "--mint", "abc", "--out-dir", "data/research/single-candidate/x"],
        /--mint/,
      ],
      [
        "same pool and mint",
        ["--pool", MINT, "--mint", MINT, "--out-dir", "data/research/single-candidate/x"],
        /must differ/,
      ],
      ["missing out-dir", ["--pool", POOL_ID, "--mint", MINT], /--out-dir is required/],
      [
        "out-dir outside the evidence root",
        ["--pool", POOL_ID, "--mint", MINT, "--out-dir", "data/research/diagnostics/x"],
        /inside data\/research\/single-candidate/,
      ],
      [
        "out-dir is the evidence root",
        ["--pool", POOL_ID, "--mint", MINT, "--out-dir", "data/research/single-candidate"],
        /inside/,
      ],
      [
        "path traversal",
        ["--pool", POOL_ID, "--mint", MINT, "--out-dir", "data/research/single-candidate/../x"],
        /inside/,
      ],
      ["live and dry-run", [...outArgs("x"), "--live", "--dry-run"], /mutually exclusive/],
      ["unknown option", [...outArgs("x"), "--retry"], /CLI_INVALID_ARG/],
      [
        "repeated pool (no silent substitution)",
        [...outArgs("x"), "--pool", "So11111111111111111111111111111111111111112"],
        /--pool may be given only once/,
      ],
      [
        "repeated out-dir in = form",
        [...outArgs("x"), "--out-dir=data/research/single-candidate/y"],
        /--out-dir may be given only once/,
      ],
    ];
    for (const [label, args, message] of bad) {
      await expect(runPaperSingleCandidateDiagnostic(args, deps), label).rejects.toThrow(message);
    }
    // An existing output directory is refused (dry run and live alike).
    mkdirSync(path.join(env.root, "data/research/single-candidate/taken"), { recursive: true });
    for (const extra of [[], ["--live"]]) {
      await expect(
        runPaperSingleCandidateDiagnostic([...outArgs("taken"), ...extra], deps),
      ).rejects.toThrow(/OUTPUT_EXISTS/);
    }
    // Live without configuration: refused before creating anything or sending anything.
    for (const missing of [
      { SOLANA_RPC_URL: undefined },
      { SOLANA_TRACKER_API_KEY: undefined },
      { SOLANA_RPC_URL: "ws://x" },
    ]) {
      await expect(
        runPaperSingleCandidateDiagnostic([...outArgs("cfg"), "--live"], {
          ...deps,
          env: { ...ENV, ...missing },
        }),
      ).rejects.toThrow(/MISSING_CONFIGURATION/);
    }
    expect(readdirSync(path.join(env.root, "data/research/single-candidate"))).toEqual(["taken"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(env.createWs).not.toHaveBeenCalled();
  });

  it("D-03: a mocked live run confirms, stops without execution, and seals verifiable evidence without secrets", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const env = liveEnv();
    const result = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("ok"), "--live"], env.deps),
    );
    expect(result.stopReason).toBe("ENTRY_CONFIRMED_NO_EXECUTION");
    expect(env.loadEnvironment).toHaveBeenCalledTimes(1);
    const dir = result.outDir!;
    expect(readdirSync(dir).sort()).toEqual([...CORE_EVIDENCE_FILES, "exchanges"].sort());
    expect(verifyPaperSingleCandidateEvidence(dir)).toMatchObject({ ok: true, problems: [] });
    const verifyLines: string[] = [];
    expect(runVerifyCli(dir, (l) => verifyLines.push(l))).toBe(true); // the operator --verify mode
    // The verifier states its scope: integrity, not strategy replay.
    expect(JSON.parse(verifyLines[0]!)).toMatchObject({
      ok: true,
      problems: [],
      scope: expect.stringMatching(/^INTEGRITY_ONLY: .*does not replay or re-validate/),
    });
    expectNoSecrets(dir);
    // One bounded response-evidence file per dispatched request.
    expect(readdirSync(path.join(dir, "exchanges"))).toHaveLength(env.h.fetchLog.length);
    expect(readJson(dir, "summary.json").evidence).toMatchObject({
      complete: true,
      exchangesRecorded: env.h.fetchLog.length,
      missingExchangeSeqs: [],
      captureFailures: 0,
    });

    const summary = readJson(dir, "summary.json");
    expect(summary.flowQualification.refreshesPublished).toBeGreaterThan(0);
    expect(summary.strategyAcceptance).toMatchObject({
      outcome: "ENTRY_CONFIRMED_NO_EXECUTION",
      armed: 1,
      executed: "NONE (decision-only: no buy, no position)",
    });
    const decisions = readJson(dir, "decisions.json") as { outcome: string }[];
    expect(decisions.map((d) => d.outcome)).toEqual(["ARMED_FIRST_TICK", "RETEST_CONFIRMED"]);
    expect(readJson(dir, "disarms.json")).toEqual([]);
    const market = readJson(dir, "market-responses.json") as {
      result: { ok: boolean; provenance: { creation: { pairCreatedAtMs: number } } };
    }[];
    expect(market).toHaveLength(3);
    expect(
      market.every(
        (m) => m.result.ok && m.result.provenance.creation.pairCreatedAtMs === PAIR_CREATED_AT_MS,
      ),
    ).toBe(true);
    const ledger = readJson(dir, "request-ledger.json") as {
      httpAttempts: number;
      ledger: unknown[];
    };
    expect(ledger.httpAttempts).toBe(env.h.fetchLog.length); // every transport call is in the ledger
    const manifest = readJson(dir, "evidence-manifest.json");
    expect(manifest).toMatchObject({
      poolId: POOL_ID,
      mintAddress: MINT,
      planDigestSha256: result.planDigestSha256,
    });
    expect(manifest.requests).toHaveLength(ledger.httpAttempts);
    const security = readJson(dir, "security-evidence.json");
    expect(security.evidence.mintAccount.response.result.value.data.parsed.type).toBe("mint");
    expect(readJson(dir, "flow-evidence.json").snapshots.length).toBeGreaterThan(0);

    // Integrity: a modified, removed or added file is detected.
    const report = path.join(dir, "report.json");
    writeFileSync(
      report,
      readFileSync(report, "utf8").replace("ENTRY_CONFIRMED", "ENTRY_CONFIRMEX"),
    );
    expect(verifyPaperSingleCandidateEvidence(dir).problems).toContain("MODIFIED:report.json");
    writeFileSync(path.join(dir, "extra.json"), "{}");
    expect(verifyPaperSingleCandidateEvidence(dir).problems).toContain("UNLISTED:extra.json");
    rmSync(path.join(dir, "decisions.json"));
    expect(verifyPaperSingleCandidateEvidence(dir).problems).toContain("MISSING:decisions.json");

    // No rerun into the same directory.
    await expect(
      runPaperSingleCandidateDiagnostic([...outArgs("ok"), "--live"], env.deps),
    ).rejects.toThrow(/OUTPUT_EXISTS/);
  });

  it("D-04: early failures are sealed: a market response without the exact pool, and the first 429", async () => {
    const wrongPool = liveEnv({
      market: () =>
        json({
          pairs: syntheticDexScreenerTokenPairsResponse({
            pairCreatedAtMs: PAIR_CREATED_AT_MS,
          }).pairs.slice(1),
          // SYNTHETIC adversarial echo of both credentials: must be redacted before sealing.
          echo: `${SYNTHETIC_TRACKER_KEY} ${ENV.SOLANA_RPC_URL}`,
        }),
    });
    const a = await drive(
      wrongPool.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("wrong-pool"), "--live"], wrongPool.deps),
    );
    expect(a.stopReason).toBe("INTAKE_REJECTED:MARKET_INTAKE_UNAVAILABLE");
    expect(verifyPaperSingleCandidateEvidence(a.outDir!).ok).toBe(true);
    const market = readJson(a.outDir!, "market-responses.json") as { result: { reason: string } }[];
    expect(market.map((m) => m.result.reason)).toEqual(["POOL_NOT_FOUND"]);
    expect(readJson(a.outDir!, "decisions.json")).toEqual([]);
    expectNoSecrets(a.outDir!);
    // The echoing response is still sealed (redacted), and it no longer claims to reproduce the
    // digest of the bytes as received.
    expect(readJson(a.outDir!, "summary.json").evidence).toMatchObject({
      complete: true,
      captureFailures: 0,
    });
    const echo = sealedExchanges(a.outDir!).find((x) => x.purpose === "MARKET_INTAKE")!;
    expect(echo.response).toMatchObject({
      bodyState: "COMPLETE",
      bodyRedacted: true,
      reproducesReceivedDigest: false,
    });
    expect(echo.response.body).toContain("[REDACTED]");

    const throttled = liveEnv({ rugCheck: () => new Response("SYNTHETIC", { status: 429 }) });
    const b = await drive(
      throttled.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("throttled"), "--live"], throttled.deps),
    );
    expect(b.stopReason).toBe("REQUEST_SESSION_STOPPED:HTTP_429_RECEIVED");
    expect(verifyPaperSingleCandidateEvidence(b.outDir!).ok).toBe(true);
    expect(readJson(b.outDir!, "summary.json").strategyAcceptance.outcome).toBe("NOT_CONFIRMED");
    expectNoSecrets(b.outDir!);
    // The throttled request is recorded truthfully: status kept, no body, never complete evidence.
    const throttledExchange = sealedExchanges(b.outDir!).find((x) => x.httpStatus === 429)!;
    expect(throttledExchange).toMatchObject({
      purpose: "RUGCHECK_REPORT",
      error: "HTTP_429_RECEIVED",
      response: { bodyState: "NOT_READ", completeEvidence: false, body: null },
    });
  });

  it("D-05: the session deadline ends the run; evidence is sealed and nothing is sent after it", async () => {
    const env = liveEnv({
      limits: {
        ...TEST_LIMITS,
        session: { ...TEST_LIMITS.session, lifetimeMs: 70_000 },
        flow: { ...TEST_LIMITS.flow, lifetimeMs: 70_000 },
      },
    });
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("deadline"), "--live"], env.deps),
    );
    expect(r.stopReason).toMatch(/LIFETIME_EXPIRED/);
    const ledger = readJson(r.outDir!, "request-ledger.json") as {
      ledger: { dispatchedAtMs: number }[];
    };
    expect(ledger.ledger.every((e) => e.dispatchedAtMs < START_MS + 70_000)).toBe(true);
    expect(verifyPaperSingleCandidateEvidence(r.outDir!).ok).toBe(true);
    const sent = env.h.fetchLog.length;
    await drive(
      env.h.sched,
      new Promise<void>((resolve) => env.h.sched.at(env.h.clock() + 60_000, resolve)),
    );
    expect(env.h.fetchLog.length).toBe(sent);
    expect(env.h.sched.count("provider")).toBe(0);
  });

  it("D-06: an operator interrupt stops cleanly, seals, and leaves no request or timer behind", async () => {
    const env = liveEnv();
    const controller = new AbortController();
    let sentAtInterrupt = 0;
    env.h.sched.at(START_MS + 62_000, () => {
      sentAtInterrupt = env.h.fetchLog.length;
      controller.abort();
    });
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("interrupt"), "--live"], {
        ...env.deps,
        signal: controller.signal,
      }),
    );
    expect(r.stopReason).toBe("OPERATOR_INTERRUPT");
    expect(env.h.fetchLog.length).toBe(sentAtInterrupt);
    expect(verifyPaperSingleCandidateEvidence(r.outDir!).ok).toBe(true);
    const report = readJson(r.outDir!, "report.json");
    expect(report.coordinator.state).toBe("STOPPED");
    expect(report.coordinator.activeTimers).toBe(0);
    expect(env.h.sched.count("provider")).toBe(0);
    await drive(
      env.h.sched,
      new Promise<void>((resolve) => env.h.sched.at(env.h.clock() + 60_000, resolve)),
    );
    expect(env.h.fetchLog.length).toBe(sentAtInterrupt);
  });
});

describe("PAPER single-candidate diagnostic evidence (offline)", () => {
  it("E-01: sealed responses re-decode independently and reconcile with every decision's consumed flow and security inputs, after replacement", async () => {
    // SYNTHETIC: the pullback comes late, so the run makes several decisions while snapshots are
    // retired and security components are replaced.
    const env = liveEnv({ market: peakThenPullback(5) });
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("replaced"), "--live"], env.deps),
    );
    const dir = r.outDir!;
    expect(verifyPaperSingleCandidateEvidence(dir).ok).toBe(true);
    expectNoSecrets(dir);

    // Every dispatched request has bounded response evidence bound to its ledger entry.
    const ledger = readJson(dir, "request-ledger.json").ledger as {
      seq: number;
      lane: string;
      owner: string;
      purpose: string;
      jsonRpcId: number | null;
      httpStatus: number | null;
    }[];
    const exchanges = sealedExchanges(dir);
    expect(exchanges.map((x) => x.seq)).toEqual(ledger.map((e) => e.seq));
    expect(ledger.length).toBe(env.h.fetchLog.length);
    exchanges.forEach((x, i) => {
      const e = ledger[i]!;
      expect(x).toMatchObject({
        seq: e.seq,
        lane: e.lane,
        owner: e.owner,
        purpose: e.purpose,
        jsonRpcId: e.jsonRpcId,
        httpStatus: e.httpStatus,
      });
      expect(x.response).toMatchObject({
        bodyState: "COMPLETE",
        completeEvidence: true,
        reproducesReceivedDigest: true,
        receivedDigestScope: "ORIGINAL_COMPLETE_BODY_BYTES",
        bodyEncoding: "utf8",
      });
      expect(sha256(Buffer.from(x.response.body!, "utf8"))).toBe(x.response.receivedBytesSha256);
      if (x.lane === "SOLANA_RPC") {
        expect(x.request.url).toBe("SOLANA_RPC_URL (configuration; not recorded)");
        expect((JSON.parse(x.response.body!) as { id: unknown }).id).toBe(x.jsonRpcId);
      }
    });
    const rpc = (method: string) => exchanges.filter((x) => x.request.rpcMethod === method);
    const body = (x: SealedExchange) => JSON.parse(x.response.body!) as { result: Loose };

    // Independent pool context from the sealed pool-layout response.
    const layout = rpc("getAccountInfo").find((x) => x.purpose === "POOL_LAYOUT")!;
    const parsed = parseRaydiumAmmV4Account(
      Buffer.from(body(layout).result.value.data[0] as string, "base64"),
      POOL_ID,
    );
    if (!parsed.ok) throw new Error("sealed pool layout does not parse");
    expect(parsed.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
    const poolContext = {
      poolId: POOL_ID,
      candidateTokenMint: parsed.state.baseMint,
      quoteTokenMint: parsed.state.quoteMint,
      baseVault: parsed.state.baseVault,
      quoteVault: parsed.state.quoteVault,
      baseMint: parsed.state.baseMint,
      quoteMint: parsed.state.quoteMint,
      orientation: "TOKEN_BASE_SOL_QUOTE" as const,
    };
    expect(poolContext).toEqual(POOL_CONTEXT);
    expect(poolContext.quoteMint).toBe(WSOL_MINT);

    // History block times and transactions, from the sealed responses only.
    const blockTimeOf = new Map<string, number | null>();
    for (const x of rpc("getSignaturesForAddress")) {
      for (const rec of body(x).result as { signature: string; blockTime: number | null }[]) {
        blockTimeOf.set(rec.signature, rec.blockTime);
      }
    }
    const transactions = new Map<string, unknown>(
      rpc("getTransaction").map((x) => [String(x.request.rpcParams![0]), body(x).result]),
    );
    const flowEvidence = readJson(dir, "flow-evidence.json");
    expect(transactions.size).toBe(flowEvidence.status.transactionRetrievals);
    expect(transactions.size).toBe(3);

    // Each decision's consumed window: re-decode its in-window transactions with the existing
    // decoder and reconcile with the recorded counts, including windows retired since.
    const inputs = readJson(dir, "decision-inputs.json");
    const finalSnapshotIds = (flowEvidence.snapshots as { summary: { id: number } }[]).map(
      (s) => s.summary.id,
    );
    let reconciled = 0;
    const retiredWindows = new Set<number>();
    for (const decision of inputs.decisions) {
      for (const read of decision.flowReads) {
        if (!read.snapshot) continue;
        const { summary, result, accountedSignatures } = read.snapshot;
        const inWindow = (accountedSignatures as string[]).filter((s) => {
          const bt = blockTimeOf.get(s);
          return (
            typeof bt === "number" &&
            bt * 1000 >= summary.windowStartMs &&
            bt * 1000 <= summary.windowEndMs
          );
        });
        expect(inWindow.length).toBe(result.underlyingOutcomes.windowSignaturesCount);
        let buys = 0;
        let sells = 0;
        for (const s of inWindow) {
          expect(transactions.has(s), `sealed transaction for ${s}`).toBe(true);
          const decoded = decodeRaydiumTransactionSwaps(transactions.get(s), poolContext);
          expect(decoded.ok).toBe(true);
          for (const event of decoded.events) {
            if (event.side === "BUY") buys++;
            else sells++;
          }
        }
        expect({ buys, sells }).toEqual({
          buys: summary.recentBuys60s,
          sells: summary.recentSells60s,
        });
        expect(result.flowCounts).toMatchObject({ recentBuys60s: buys, recentSells60s: sells });
        if (read.result.isCoverageSufficient) {
          expect(read.result).toMatchObject({ recentBuys60s: buys, recentSells60s: sells });
        }
        reconciled++;
        if (!finalSnapshotIds.includes(summary.id)) retiredWindows.add(summary.id);
      }
    }
    expect(reconciled).toBeGreaterThanOrEqual(3);
    expect(retiredWindows.size).toBeGreaterThanOrEqual(2); // consumed windows retired by the end

    // Security inputs of the first decision: bound to the requests of the refresh that produced
    // them, and kept although the cache has been replaced since.
    const first = inputs.decisions[0].securityReads[0];
    const finalCache = readJson(dir, "security-evidence.json").cache;
    expect(first.sources.MINT_ACCOUNT.retrievedAtMs).not.toBe(
      finalCache.retrievedAtMs.MINT_ACCOUNT,
    );
    expect(first.sources.LP.retrievedAtMs).not.toBe(finalCache.retrievedAtMs.LP);
    const refresh = (inputs.securityRefreshes as { refresh: number; requestSeqs: number[] }[]).find(
      (x) => x.refresh === first.sources.MINT_ACCOUNT.refresh,
    )!;
    expect(first.sources.MINT_ACCOUNT.refreshRequestSeqs).toEqual(refresh.requestSeqs);
    const mintExchange = exchanges.find(
      (x) => refresh.requestSeqs.includes(x.seq) && x.purpose === "CANDIDATE_MINT_ACCOUNT",
    )!;
    expect(first.evidence.mintAccount.response).toEqual(body(mintExchange));
    // A decision made while a refresh was pending records the withheld component as absent.
    const withheld = (inputs.decisions as { securityReads: Loose[] }[]).find((d) =>
      d.securityReads.some((s) => s.sources.LP.present === false),
    );
    expect(withheld).toBeDefined();
  });

  it("E-02: a body over the limit is kept only as a marked partial prefix and never as complete evidence", async () => {
    const lanes = TEST_LIMITS.session.lanes;
    const env = liveEnv({
      limits: {
        ...TEST_LIMITS,
        session: {
          ...TEST_LIMITS.session,
          lanes: { ...lanes, RUGCHECK: { ...lanes.RUGCHECK, maxResponseBytes: 64 } },
        },
      },
    });
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("partial"), "--live"], env.deps),
    );
    const dir = r.outDir!;
    expect(verifyPaperSingleCandidateEvidence(dir).ok).toBe(true);
    const partial = sealedExchanges(dir).find((x) => x.purpose === "RUGCHECK_REPORT")!;
    expect(partial).toMatchObject({
      error: "RESPONSE_TOO_LARGE",
      response: {
        bodyState: "PARTIAL_OVERFLOW",
        completeEvidence: false,
        receivedDigestScope: "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
      },
    });
    expect(partial.response.retainedBytes).toBeLessThanOrEqual(64);
    expect(partial.response.observedBytes!).toBeGreaterThan(64);
    const prefix =
      partial.response.bodyEncoding === "base64"
        ? Buffer.from(partial.response.body!, "base64")
        : Buffer.from(partial.response.body!, "utf8");
    expect(prefix.length).toBe(partial.response.retainedBytes);
    expect(sha256(prefix)).toBe(partial.response.receivedBytesSha256);
    expect(readJson(dir, "summary.json").evidence.bodies.partial).toBeGreaterThanOrEqual(1);
    // The partial prefix never became security evidence.
    expect(readJson(dir, "security-evidence.json").evidence?.rugCheck?.response ?? null).toBeNull();
  });

  it("V-01: the verifier fails closed on manifest, path, digest, reference and recursive-entry problems", async () => {
    const env = liveEnv();
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("sealed"), "--live"], env.deps),
    );
    const sealed = r.outDir!;
    expect(verifyPaperSingleCandidateEvidence(sealed)).toMatchObject({ ok: true, problems: [] });
    const problems = (dir: string) => {
      const v = verifyPaperSingleCandidateEvidence(dir);
      expect(v.ok).toBe(false);
      expect(v.scope).toMatch(/^INTEGRITY_ONLY/);
      return v.problems;
    };

    // A modified report reference.
    expect(
      problems(
        tamperedCopy(sealed, "report-ref", (m) => {
          m.reportFile.sha256 = "0".repeat(64);
        }),
      ),
    ).toEqual(
      expect.arrayContaining(["REPORT_FILE_ENTRY_MISMATCH", "REPORT_FILE_DIGEST_MISMATCH"]),
    );

    // A directory holding only a manifest that lists nothing and points at itself.
    const bare = path.join(tempProject(), "bare");
    mkdirSync(bare);
    for (const header of [
      {},
      { kind: "PAPER_SINGLE_CANDIDATE_EVIDENCE_MANIFEST", manifestVersion: 2 },
    ]) {
      writeFileSync(
        path.join(bare, "evidence-manifest.json"),
        JSON.stringify({
          ...header,
          planDigestSha256: "0".repeat(64),
          files: [],
          reportFile: { path: "evidence-manifest.json", sha256: "0".repeat(64), bytes: 0 },
        }),
      );
      expect(problems(bare)).toEqual(
        expect.arrayContaining([
          "REQUIRED_ENTRY_MISSING:report.json",
          "REQUIRED_ENTRY_MISSING:plan.json",
          "REQUIRED_ENTRY_MISSING:request-exchanges.json",
          "REPORT_FILE_PATH_INVALID",
          "REPORT_NOT_LISTED",
        ]),
      );
    }
    writeFileSync(path.join(bare, "evidence-manifest.json"), "not json");
    expect(problems(bare)).toEqual(["MANIFEST_INVALID_JSON"]);

    // Duplicate, absolute and traversal paths; invalid sizes, digests and categories.
    const entryOf = (m: Record<string, Loose>, p: string) =>
      (m.files as Record<string, Loose>[]).find((f) => f.path === p)!;
    expect(
      problems(
        tamperedCopy(sealed, "paths", (m) => {
          const plan = entryOf(m, "plan.json");
          m.files.push(
            { ...plan },
            { ...plan, path: "/etc/passwd" },
            { ...plan, path: "C:/Windows/win.ini" },
            { ...plan, path: "../outside.json" },
            { ...plan, path: "exchanges/../plan.json" },
            { ...plan, path: "exchanges\\0001.json" },
          );
          entryOf(m, "decisions.json").bytes = -1;
          (entryOf(m, "disarms.json") as Loose).bytes = 1.5;
          (entryOf(m, "summary.json") as Loose).sha256 = "abc";
          (entryOf(m, "flow-evidence.json") as Loose).category = "REPORT";
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "DUPLICATE_PATH:plan.json",
        "INVALID_SIZE:decisions.json",
        "INVALID_SIZE:disarms.json",
        "INVALID_DIGEST:summary.json",
        "INVALID_CATEGORY:flow-evidence.json",
        "MODIFIED:decisions.json",
      ]),
    );
    const invalidPaths = problems(
      tamperedCopy(sealed, "paths-only", (m) => {
        const plan = entryOf(m, "plan.json");
        m.files.push(
          { ...plan, path: "/etc/passwd" },
          { ...plan, path: "C:/Windows/win.ini" },
          { ...plan, path: "../outside.json" },
          { ...plan, path: "exchanges/../plan.json" },
          { ...plan, path: "exchanges\\0001.json" },
        );
      }),
    ).filter((p) => p.startsWith("INVALID_PATH:"));
    expect(invalidPaths).toHaveLength(5);

    // Plan-digest references: the sealed plan and the report must agree with the manifest.
    const planEdited = tamperedCopy(sealed, "plan-edited");
    const planPath = path.join(planEdited, "plan.json");
    writeFileSync(planPath, readFileSync(planPath, "utf8").replace('"LIVE"', '"DRY_RUN"'));
    const rewritten = readJson(planEdited, "evidence-manifest.json");
    Object.assign(entryOf(rewritten, "plan.json"), {
      sha256: sha256(readFileSync(planPath)),
      bytes: readFileSync(planPath).length,
    });
    writeFileSync(path.join(planEdited, "evidence-manifest.json"), JSON.stringify(rewritten));
    expect(problems(planEdited)).toEqual(["PLAN_DIGEST_MISMATCH"]);
    expect(
      problems(
        tamperedCopy(sealed, "plan-ref", (m) => {
          m.planDigestSha256 = "1".repeat(64);
        }),
      ),
    ).toEqual(["PLAN_DIGEST_MISMATCH", "REPORT_PLAN_DIGEST_MISMATCH"]);

    // Recursive: unlisted and missing response evidence in the subdirectory, and an unindexed one.
    const extra = tamperedCopy(sealed, "extra");
    writeFileSync(path.join(extra, "exchanges", "9999.json"), "{}");
    mkdirSync(path.join(extra, "exchanges", "nested"));
    writeFileSync(path.join(extra, "exchanges", "nested", "x.json"), "{}");
    expect(problems(extra)).toEqual([
      "UNLISTED:exchanges/9999.json",
      "UNLISTED:exchanges/nested/x.json",
    ]);
    const missing = tamperedCopy(sealed, "missing");
    rmSync(path.join(missing, "exchanges", "0003.json"));
    expect(problems(missing)).toEqual(["MISSING:exchanges/0003.json"]);
    const unindexed = tamperedCopy(sealed, "unindexed", (m) => {
      const first = entryOf(m, "exchanges/0001.json");
      m.files.push({ ...first, path: "exchanges/0001-copy.json" });
    });
    cpSync(
      path.join(unindexed, "exchanges", "0001.json"),
      path.join(unindexed, "exchanges", "0001-copy.json"),
    );
    expect(problems(unindexed)).toEqual(["RESPONSE_NOT_INDEXED:exchanges/0001-copy.json"]);

    // The CLI reports a failure and its scope.
    const lines: string[] = [];
    expect(runVerifyCli(missing, (l) => lines.push(l))).toBe(false);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: false,
      scope: expect.stringMatching(/^INTEGRITY_ONLY/),
    });
  });

  it("R-01: a credential-bearing transport exception is redacted from terminal output, stop reasons, sealed files and propagated errors", async () => {
    const env = liveEnv();
    const failingWs = vi.fn((wsUrl: string): never => {
      // SYNTHETIC exception echoing every configured credential.
      throw new Error(
        `SYNTHETIC socket failure ${wsUrl} key=${SYNTHETIC_TRACKER_KEY} rpc=${ENV.SOLANA_RPC_URL}`,
      );
    });
    const r = await drive(
      env.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("ws-failure"), "--live"], {
        ...env.deps,
        createWebSocketTransport: failingWs,
      }),
    );
    expect(failingWs).toHaveBeenCalledWith(SYNTHETIC_WS_URL);
    // Useful stop code and first failure cause are kept; the credentials are not.
    expect(r.stopReason).toMatch(
      /^FLOW_COLLECTION_ENDED:INTERNAL_ERROR: SYNTHETIC socket failure /,
    );
    expect(r.stopReason).toContain("[REDACTED]");
    const output = env.lines.join("\n");
    expect(output).toContain("[LIVE] Stop reason: FLOW_COLLECTION_ENDED:INTERNAL_ERROR");
    for (const secret of SECRETS) {
      expect(output.includes(secret), "terminal output contains a credential").toBe(false);
      expect(r.stopReason!.includes(secret)).toBe(false);
    }
    expectNoSecrets(r.outDir!);
    expect(verifyPaperSingleCandidateEvidence(r.outDir!).ok).toBe(true);

    // A propagated error (here from the output sink) is redacted before it leaves the runner.
    const sink = liveEnv();
    const run = runPaperSingleCandidateDiagnostic([...outArgs("sink-failure"), "--live"], {
      ...sink.deps,
      log: (line) => {
        if (line.includes("Configuration loaded")) {
          throw new Error(`SYNTHETIC sink failure ${ENV.SOLANA_RPC_URL} ${SYNTHETIC_TRACKER_KEY}`);
        }
      },
    });
    const error = await run.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/^SYNTHETIC sink failure /);
    for (const secret of SECRETS) expect(error!.message.includes(secret)).toBe(false);
  });
});
