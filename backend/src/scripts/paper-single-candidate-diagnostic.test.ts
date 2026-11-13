/**
 * PAPER single-candidate operator diagnostic (offline): strict market parser, dry-run boundary,
 * argument and output refusals, and mocked live runs through the accepted coordinator on the shared
 * virtual scheduler. Every response, key and value is SYNTHETIC; no real network, socket or daemon.
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_APPROVAL_STATUS,
  PROPOSED_SINGLE_CANDIDATE_LIMITS,
  buildRequestAllocation,
  runPaperSingleCandidateDiagnostic,
  runVerifyCli,
  verifyPaperSingleCandidateEvidence,
  type PaperSingleCandidateDiagnosticDeps,
} from "./paper-single-candidate-diagnostic.js";
import {
  parseDexScreenerTokenPairs,
  WSOL_MINT_ADDRESS,
} from "../candidate-scanner/DexScreenerSingleCandidateMarketParser.js";
import type { PaperCoordinatorLimits } from "../candidate-scanner/PaperSingleCandidateCoordinator.js";
import {
  MINT,
  OFFLINE_TEST_LIMITS,
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

/** No secret anywhere in the sealed directory. */
function expectNoSecrets(dir: string) {
  for (const name of readdirSync(dir)) {
    const content = readFileSync(path.join(dir, name), "utf8");
    for (const secret of [SYNTHETIC_RPC_KEY, SYNTHETIC_TRACKER_KEY, ENV.SOLANA_RPC_URL]) {
      expect(content.includes(secret), `${name} contains a secret`).toBe(false);
    }
  }
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
    expect(readdirSync(dir).sort()).toEqual([...result.plan.evidenceFiles].sort());
    expect(verifyPaperSingleCandidateEvidence(dir)).toEqual({ ok: true, problems: [] });
    const verifyLines: string[] = [];
    expect(runVerifyCli(dir, (l) => verifyLines.push(l))).toBe(true); // the operator --verify mode
    expect(JSON.parse(verifyLines[0]!)).toEqual({ ok: true, problems: [] });
    expectNoSecrets(dir);

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

    const throttled = liveEnv({ rugCheck: () => new Response("SYNTHETIC", { status: 429 }) });
    const b = await drive(
      throttled.h.sched,
      runPaperSingleCandidateDiagnostic([...outArgs("throttled"), "--live"], throttled.deps),
    );
    expect(b.stopReason).toBe("REQUEST_SESSION_STOPPED:HTTP_429_RECEIVED");
    expect(verifyPaperSingleCandidateEvidence(b.outDir!).ok).toBe(true);
    expect(readJson(b.outDir!, "summary.json").strategyAcceptance.outcome).toBe("NOT_CONFIRMED");
    expectNoSecrets(b.outDir!);
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
