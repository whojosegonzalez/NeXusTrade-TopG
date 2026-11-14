/**
 * Stage A precheck (offline): selection, rejected identities, timestamp handling and request
 * bounds, on SYNTHETIC responses and virtual time. No real network, socket or daemon.
 */
import path from "node:path";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEE_DESTINATION_SOURCE,
  PLANNING_START_WINDOW,
  PRECHECK_LIMITS,
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  derivePrecheckSelection,
  runFreshPoolPrecheck,
  type EvidenceFileWriter,
  type PrecheckExchange,
} from "./fresh-amm-v4-precheck.js";
import { loadVerifiedExchanges, verifyPrecheckEvidence } from "./paper-pilot-handoff.js";
import {
  ENV,
  FEE,
  MATCH_BLOCK_TIME,
  MATCH_OPEN_TIME,
  MATCH_PAIR_CREATED_AT_MS,
  MINT,
  NOW_SEC,
  POOL,
  SYNTHETIC_RPC_KEY,
  WSOL_MINT,
  drive,
  json,
  key,
  marketResponse,
  precheckEnv,
  sig,
  standardScenario,
} from "./fresh-amm-v4-precheck.test-support.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const filesUnder = (dir: string, rel = ""): string[] =>
  readdirSync(path.join(dir, rel)).flatMap((n) => {
    const child = rel ? `${rel}/${n}` : n;
    return statSync(path.join(dir, child)).isDirectory() ? filesUnder(dir, child) : [child];
  });
const readJson = (dir: string, rel: string) =>
  JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
const sealedExchanges = (dir: string): PrecheckExchange[] =>
  (readJson(dir, "request-exchanges.json").exchanges as { file: string }[]).map((x) =>
    readJson(dir, x.file),
  );

function expectNoSecrets(dir: string, lines: readonly string[]) {
  for (const s of [SYNTHETIC_RPC_KEY, ENV.SOLANA_RPC_URL]) {
    for (const f of filesUnder(dir)) {
      expect(readFileSync(path.join(dir, f), "utf8").includes(s), `${f} holds a credential`).toBe(
        false,
      );
    }
    expect(lines.join("\n").includes(s)).toBe(false);
  }
}

describe("Stage A fresh AMM v4 precheck (offline, SYNTHETIC)", () => {
  it("A-01: selects the newest decoded match in the bounded sample, keeps every time source apart, and seals verifiable evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const env = precheckEnv(standardScenario());
    roots.push(env.projectRoot);
    const r = await env.run("a01");
    const sel = r.selection!;
    expect(sel.outcome).toBe("TARGET_SELECTED");
    expect(sel.signatures.map((s) => s.status)).toEqual([
      "NOT_RETRIEVED_FAILED_TRANSACTION",
      "NOT_RETRIEVED_BLOCK_TIME_UNAVAILABLE",
      "DECODED_NONMATCH:UNSUPPORTED_ORIENTATION_WSOL_BASE",
      "DECODED_MATCH",
      "NOT_RETRIEVED_SAMPLE_BOUND",
      "NOT_RETRIEVED_OUTSIDE_PREFILTER",
    ]);
    const t = sel.target!;
    expect(t).toMatchObject({
      poolId: POOL,
      mintAddress: MINT,
      quoteMint: WSOL_MINT,
      orientation: "CANDIDATE_BASE_WSOL_QUOTE",
      eligibility: "PROVISIONAL: security and strategy eligibility are unverified",
    });
    // Three distinct time sources, each preserved with its provenance.
    expect(t.initialization).toMatchObject({
      signature: sig(104),
      transactionBlockTimeSec: MATCH_BLOCK_TIME,
      signatureBlockTimeSec: MATCH_BLOCK_TIME,
      instructionRequestedOpenTimeSec: MATCH_OPEN_TIME,
      feeDestination: { accountIndex: 14, address: FEE },
    });
    expect(t.market.pairCreatedAtMs).toBe(MATCH_PAIR_CREATED_AT_MS);
    const runnerOpen = Math.floor(MATCH_PAIR_CREATED_AT_MS / 1000);
    expect(t.market.runnerOpenTimeSec).toBe(runnerOpen);
    expect(runnerOpen).not.toBe(MATCH_BLOCK_TIME);
    expect(runnerOpen).not.toBe(MATCH_OPEN_TIME);
    // The start window is computed from the runner's age source and labelled an estimate.
    expect(t.startWindow).toMatchObject({
      opensAtMs: (runnerOpen + 240) * 1000,
      closesAtMs: (runnerOpen + 760) * 1000,
      status: expect.stringMatching(/^PLANNING_ESTIMATE/),
      basis: expect.stringMatching(/^DEXSCREENER_PAIR_CREATED_AT/),
    });
    // Bounded requests: 3 Solana RPC (paced) + 1 market GET on the runner's endpoint.
    expect(env.fetchLog.map((f) => f.rpcMethod ?? "MARKET")).toEqual([
      "getSignaturesForAddress",
      "getTransaction",
      "getTransaction",
      "MARKET",
    ]);
    const rpcTimes = env.fetchLog.filter((f) => f.rpcMethod).map((f) => f.atMs);
    expect(rpcTimes[1]! - rpcTimes[0]!).toBeGreaterThanOrEqual(2_500);
    expect(rpcTimes[2]! - rpcTimes[1]!).toBeGreaterThanOrEqual(2_500);
    expect(env.fetchLog[3]!.url).toBe(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Sealed, verifiable, reproducible from the sealed responses, and free of credentials.
    const dir = r.outDir!;
    expect(verifyPrecheckEvidence(dir)).toEqual([]);
    expect(derivePrecheckSelection(sealedExchanges(dir), { complete: true }).selection).toEqual(
      readJson(dir, "selection.json"),
    );
    expect(
      sealedExchanges(dir)
        .filter((x) => x.lane === "SOLANA_RPC")
        .every((x) => x.request.url.startsWith("SOLANA_RPC_URL")),
    ).toBe(true);
    expectNoSecrets(dir, env.lines);
    expect(readJson(dir, "plan.json").endpoints.webSocket).toBe("NONE");
  });

  it("A-02: rejected identities are decoded non-matches or unavailable evidence, kept distinct; no market request without a match", async () => {
    const cases: {
      name: string;
      a: Partial<Parameters<typeof standardScenario>[0]>;
      statuses: [string, string];
      outcome: string;
    }[] = [
      {
        name: "fee-and-quote",
        a: {
          transactions: [
            {
              signature: sig(103),
              slot: 998,
              blockTime: NOW_SEC - 60,
              feeDestination: key("not-the-fee-account"),
            },
            { signature: sig(104), slot: 997, blockTime: NOW_SEC - 120, pcMint: key("usdc-like") },
          ],
        },
        statuses: ["DECODED_NONMATCH:FEE_DESTINATION_MISMATCH", "DECODED_NONMATCH:NO_WSOL_QUOTE"],
        outcome: "SAMPLE_PRODUCED_NO_SUITABLE_TARGET",
      },
      {
        name: "signature-and-failed",
        a: {
          transactions: [
            {
              signature: sig(103),
              slot: 998,
              blockTime: NOW_SEC - 60,
              returnedSignature: sig(999),
            },
            {
              signature: sig(104),
              slot: 997,
              blockTime: NOW_SEC - 120,
              err: { InstructionError: [0, "Custom"] },
            },
          ],
        },
        statuses: [
          "EVIDENCE_UNAVAILABLE:SIGNATURE_MISMATCH",
          "DECODED_NONMATCH:TRANSACTION_NOT_SUCCESSFUL",
        ],
        outcome: "SAMPLE_PRODUCED_NO_SUITABLE_TARGET",
      },
      {
        name: "envelope",
        a: {
          transactions: [
            { signature: sig(103), slot: 998, blockTime: NOW_SEC - 60, idOffset: 7 },
            { signature: sig(104), slot: 997, blockTime: NOW_SEC - 120, result: null },
          ],
        },
        statuses: [
          "EVIDENCE_UNAVAILABLE:RPC_ID_MISMATCH",
          "EVIDENCE_UNAVAILABLE:TRANSACTION_UNAVAILABLE",
        ],
        outcome: "EVIDENCE_UNAVAILABLE",
      },
      {
        name: "requests",
        a: { transactionResponse: () => new Response("SYNTHETIC", { status: 503 }) },
        statuses: ["REQUEST_FAILED:HTTP_503", "REQUEST_FAILED:HTTP_503"],
        outcome: "REQUEST_FAILED",
      },
    ];
    for (const c of cases) {
      const env = precheckEnv(standardScenario(c.a));
      roots.push(env.projectRoot);
      const r = await env.run(`a02-${c.name}`);
      const sel = r.selection!;
      expect([sel.signatures[2]!.status, sel.signatures[3]!.status], c.name).toEqual(c.statuses);
      expect(sel.outcome, c.name).toBe(c.outcome);
      expect(sel.target, c.name).toBeNull();
      expect(sel.sampleStatement).toMatch(
        /establishes only that this sample produced no suitable target/,
      );
      expect(
        env.fetchLog.some((f) => f.rpcMethod === null),
        c.name,
      ).toBe(false);
      expect(verifyPrecheckEvidence(r.outDir!), c.name).toEqual([]);
    }

    // A match whose market evidence names another pool: the handoff evidence is unavailable.
    const other = precheckEnv(
      standardScenario({
        market: () => json(marketResponse(MATCH_PAIR_CREATED_AT_MS, key("another-pool"))),
      }),
    );
    roots.push(other.projectRoot);
    const o = await other.run("a02-market-identity");
    expect(o.selection).toMatchObject({
      outcome: "MARKET_EVIDENCE_UNAVAILABLE",
      reason: "POOL_NOT_FOUND",
      target: null,
    });
  });

  it("A-03: the start window uses pairCreatedAt; a closed window and missing creation time stop the handoff", async () => {
    // pairCreatedAt older than the window although the block time passed the prefilter.
    const old = precheckEnv(
      standardScenario({ market: () => json(marketResponse((NOW_SEC - 2_000) * 1000)) }),
    );
    roots.push(old.projectRoot);
    const a = await old.run("a03-closed");
    expect(a.selection!.outcome).toBe("START_WINDOW_ALREADY_CLOSED");
    // The candidate's timestamps are preserved although it is not selected.
    expect(a.selection!.target).toMatchObject({
      initialization: {
        transactionBlockTimeSec: MATCH_BLOCK_TIME,
        instructionRequestedOpenTimeSec: MATCH_OPEN_TIME,
      },
      market: { pairCreatedAtMs: (NOW_SEC - 2_000) * 1000 },
    });
    expect(a.selection!.target!.market.ageSecAtReceipt).toBeGreaterThan(
      PLANNING_START_WINDOW.maxAgeSec,
    );

    const missing = precheckEnv(
      standardScenario({ market: () => json(marketResponse(undefined)) }),
    );
    roots.push(missing.projectRoot);
    const b = await missing.run("a03-missing");
    expect(b.selection).toMatchObject({
      outcome: "MARKET_EVIDENCE_UNAVAILABLE",
      reason: "CREATION_TIME_UNAVAILABLE",
      target: null,
    });

    const failed = precheckEnv(
      standardScenario({ market: () => new Response("x", { status: 500 }) }),
    );
    roots.push(failed.projectRoot);
    const c = await failed.run("a03-market-failed");
    expect(c.selection).toMatchObject({
      outcome: "MARKET_EVIDENCE_UNAVAILABLE",
      reason: "HTTP_500",
    });
  });

  it("A-04: request bounds hold: 20 signatures, 2 retrievals, first 429, the 30 s deadline, and a zero-dispatch dry run", async () => {
    // Twenty eligible signatures: still exactly two retrievals.
    const many = Array.from({ length: 20 }, (_, i) => ({
      signature: sig(200 + i),
      slot: 2_000 - i,
      blockTime: NOW_SEC - 30 - i,
      err: null,
    }));
    const a = precheckEnv({ signatures: many, transactions: [] });
    roots.push(a.projectRoot);
    const ra = await a.run("a04-twenty");
    expect(a.fetchLog.filter((f) => f.rpcMethod === "getTransaction")).toHaveLength(2);
    expect(
      ra.selection!.signatures.filter((s) => s.status === "NOT_RETRIEVED_SAMPLE_BOUND"),
    ).toHaveLength(18);
    expect(ra.selection!.outcome).toBe("EVIDENCE_UNAVAILABLE"); // both results null

    // A page larger than the sample is unusable evidence; nothing else is requested.
    const b = precheckEnv({
      signatures: [...many, { signature: sig(299), slot: 1, blockTime: NOW_SEC - 30, err: null }],
    });
    roots.push(b.projectRoot);
    const rb = await b.run("a04-oversized");
    expect(rb.selection).toMatchObject({
      outcome: "EVIDENCE_UNAVAILABLE",
      reason: "EVIDENCE_UNAVAILABLE:SIGNATURE_PAGE_TOO_LARGE",
    });
    expect(b.fetchLog).toHaveLength(1);

    // The first 429 stops everything.
    const c = precheckEnv({ signatures: () => new Response("SYNTHETIC", { status: 429 }) });
    roots.push(c.projectRoot);
    const rc = await c.run("a04-429");
    expect(rc.selection).toMatchObject({
      outcome: "REQUEST_FAILED",
      reason: "REQUEST_FAILED:HTTP_429_RECEIVED",
    });
    expect(c.fetchLog).toHaveLength(1);
    expect(readJson(rc.outDir!, "request-ledger.json").stopReason).toBe("HTTP_429_RECEIVED");

    // A hanging provider ends within the 30 s deadline (here at the 10 s request timeout).
    const hang = precheckEnv({
      signatures: () => new Promise<Response>(() => undefined) as unknown as Response,
    });
    roots.push(hang.projectRoot);
    const rh = await hang.run("a04-hang");
    expect(hang.sched.now - 1_791_931_000_000).toBeLessThanOrEqual(PRECHECK_LIMITS.lifetimeMs);
    expect(rh.selection).toMatchObject({
      outcome: "REQUEST_FAILED",
      reason: "REQUEST_FAILED:REQUEST_TIMED_OUT",
    });
    expect(hang.sched.count("provider")).toBe(0);

    // Dry run: nothing dispatched, configuration not loaded, nothing written.
    const loadEnvironment = vi.fn();
    const e = precheckEnv(standardScenario());
    roots.push(e.projectRoot);
    const dry = await runFreshPoolPrecheck(["--out-dir", "data/research/prechecks/a04-dry"], {
      ...e.deps,
      loadEnvironment,
    });
    expect(dry.mode).toBe("DRY_RUN");
    expect(e.fetchLog).toHaveLength(0);
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(existsSync(path.join(e.projectRoot, "data"))).toBe(false);
    expect(e.lines.join("\n")).toContain('"webSocket": "NONE"');

    // The proposed limits: 3 Solana RPC + 1 market, all other lanes disabled.
    expect(PRECHECK_LIMITS.maxHttpAttempts).toBe(4);
    expect(PRECHECK_LIMITS.lanes.SOLANA_RPC).toMatchObject({ maxAttempts: 3, pacingMs: 2_500 });
    expect(PRECHECK_LIMITS.lanes.DEXSCREENER.maxAttempts).toBe(1);
    expect(
      PRECHECK_LIMITS.lanes.RUGCHECK.maxAttempts + PRECHECK_LIMITS.lanes.SOLANA_TRACKER.maxAttempts,
    ).toBe(0);
    expect(RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION).toBe(
      "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
    );
  });
});

describe("Stage A precheck corrections (review of 6515fcb)", () => {
  it("A-05: a failed evidence write stops dispatch; the request is never repeated and the evidence is reported incomplete", async () => {
    const env = precheckEnv(standardScenario());
    roots.push(env.projectRoot);
    let failed = 0;
    const writeEvidenceFile: EvidenceFileWriter = (file, content, options) => {
      if (failed === 0 && path.basename(file) === "0001.json") {
        failed++;
        throw new Error("SYNTHETIC disk write failure");
      }
      writeFileSync(file, content, options);
    };
    const r = await drive(
      env.sched,
      runFreshPoolPrecheck(["--out-dir", "data/research/prechecks/a05", "--live"], {
        ...env.deps,
        writeEvidenceFile,
      }),
    );
    // Exactly one request: the signature page was not requested a second time.
    expect(env.fetchLog.map((f) => f.rpcMethod)).toEqual(["getSignaturesForAddress"]);
    expect(r.selection).toMatchObject({
      outcome: "EVIDENCE_INCOMPLETE",
      reason: "CAPTURE_FAILED: SYNTHETIC disk write failure",
      target: null,
    });
    const dir = r.outDir!;
    const ledger = readJson(dir, "request-ledger.json");
    expect(ledger.ledger).toHaveLength(1);
    expect(ledger.stopReason).toBe("EVIDENCE_CAPTURE_FAILED");
    expect(readJson(dir, "request-exchanges.json")).toMatchObject({
      exchanges: [],
      missingExchangeSeqs: [1],
      captureFailures: ["SYNTHETIC disk write failure"],
      stoppedBy: "EVIDENCE_CAPTURE_FAILED",
    });
    // The seal itself is intact; the handoff refuses incomplete evidence.
    expect(verifyPrecheckEvidence(dir)).toEqual([]);
    expect(loadVerifiedExchanges(dir)).toEqual({
      ok: false,
      refusals: ["EVIDENCE_INCOMPLETE:MISSING_EXCHANGES"],
    });
  });

  it("A-06: the plan records the verified upstream revision as immutable references", async () => {
    expect(FEE_DESTINATION_SOURCE).toMatchObject({
      address: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      accountIndex: 14,
      revision: "91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6",
      declaredIn:
        "https://github.com/raydium-io/raydium-amm/blob/91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6/program/src/processor.rs",
      accountVector:
        "https://github.com/raydium-io/raydium-amm/blob/91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6/program/src/instruction.rs",
    });
    expect(JSON.stringify(FEE_DESTINATION_SOURCE)).not.toMatch(/\/blob\/master\//);
  });
});
