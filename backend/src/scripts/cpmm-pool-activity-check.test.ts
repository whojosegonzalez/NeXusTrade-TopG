/**
 * Offline unit and integration tests for `cpmm-pool-activity-check.ts`.
 * Every provider, timer, clock and filesystem directory is synthetic and local to OS temp dirs.
 * Zero real credentials, configuration loads, network calls, sockets or live requests.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACTIVITY_CHECK_EXIT_CODES,
  ACTIVITY_CHECK_FILES,
  ACTIVITY_CHECK_LIMITATIONS,
  ACTIVITY_CHECK_LIMITS,
  ACTIVITY_CHECK_NON_CERTIFICATIONS,
  ACTIVITY_CHECK_RPC_METHOD,
  ACTIVITY_CHECK_RPC_URL_PLACEHOLDER,
  ACTIVITY_CHECK_USAGE,
  analyzePoolActivityResponse,
  type buildActivityCheckPlan,
  isCpmmActivityCheckMainModule,
  isSolanaAddress,
  printableActivityCheckError,
  runCpmmPoolActivityCheckCli,
  verifyActivityCheckEvidence,
  type ActivityCheckCliDeps,
  type ActivityCheckSignal,
} from "./cpmm-pool-activity-check.js";
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";

const POOL = "47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4";
const RPC_KEY = "SYNTHETIC-activity-key-24680";
const RPC_URL = `https://rpc.synthetic.invalid/?api-key=${RPC_KEY}`;
const ENV = Object.freeze({ SOLANA_RPC_URL: RPC_URL });
const OUT_REL = "data/research/cpmm-activity-checks/check-01";
const START_MS = 1_795_600_000_000;
const BASE_SEC = Math.floor(START_MS / 1000);
const X = ACTIVITY_CHECK_EXIT_CODES;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

const sig = (n: number): string => {
  const bytes = Buffer.alloc(64, 1);
  bytes.writeUInt32BE(n, 0);
  bytes.writeUInt32BE(n ^ 0x5a5a5a5a, 60);
  return encodeBase58(bytes);
};

interface RawSigRec {
  signature?: unknown;
  slot: unknown;
  blockTime: unknown;
  err?: unknown;
  memo?: unknown;
  confirmationStatus?: unknown;
  transactionIndex?: unknown;
  extraField?: unknown;
}

const rec = (
  n: number,
  slot: number,
  blockTime: number | null,
  extra: Partial<RawSigRec> = {},
): RawSigRec => ({
  signature: sig(n),
  slot,
  err: null,
  memo: null,
  blockTime,
  confirmationStatus: "confirmed",
  ...extra,
});

const rpcBody = (records: unknown[], id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: records });

class VirtualScheduler {
  now: number;
  private nextId = 1;
  private readonly queue: { id: number; at: number; fn: () => void }[] = [];

  constructor(startMs = START_MS) {
    this.now = startMs;
  }

  add(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.queue.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  }

  clear(handle: unknown): void {
    const id = Number(handle);
    const idx = this.queue.findIndex((item) => item.id === id);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  async runTo(targetMs: number): Promise<void> {
    while (true) {
      let nextIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i]!;
        if (item.at <= targetMs && (nextIdx === -1 || item.at < this.queue[nextIdx]!.at)) {
          nextIdx = i;
        }
      }
      if (nextIdx === -1) break;
      const [item] = this.queue.splice(nextIdx, 1);
      this.now = Math.max(this.now, item!.at);
      item!.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    if (targetMs > this.now) this.now = targetMs;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface FetchScript {
  status?: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  delayMs?: number;
  throwError?: string;
}

function makeHarness(opts: { fetch?: FetchScript; env?: Record<string, string | undefined> } = {}) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "cpmm-activity-check-"));
  roots.push(projectRoot);
  const sched = new VirtualScheduler(START_MS);
  const logs: string[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let loadCalls = 0;

  const f = opts.fetch ?? { body: rpcBody([rec(1, 500, BASE_SEC - 10)]) };
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    await new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), f.delayMs ?? 100);
      init?.signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error(`aborted:${RPC_URL}`));
        },
        { once: true },
      );
    });
    if (f.throwError !== undefined) throw new Error(f.throwError);
    const body = f.body ?? rpcBody([rec(1, 500, BASE_SEC - 10)]);
    const bodyInit = typeof body === "string" ? body : Buffer.from(body);
    return new Response(bodyInit, {
      status: f.status ?? 200,
      headers: { "content-type": "application/json", ...f.headers },
    });
  }) as unknown as typeof fetch;

  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => sched.add(fn, ms),
    clearTimeout: (handle) => sched.clear(handle),
  };

  const deps = (extra: Partial<ActivityCheckCliDeps> = {}): ActivityCheckCliDeps => ({
    env: opts.env ?? ENV,
    loadEnvironment: () => {
      loadCalls++;
    },
    fetchFn,
    clock: () => sched.now,
    timers,
    projectRoot,
    log: (l) => logs.push(l),
    ...extra,
  });

  async function drive<T>(promise: Promise<T>, advanceMs = 15_000): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    const targetMs = START_MS + advanceMs;
    while (!settled) {
      await new Promise<void>((r) => setImmediate(r));
      if (sched.hasPending()) {
        await sched.runTo(targetMs);
      } else if (settled) {
        break;
      }
    }
    return tracked;
  }

  async function runLive(extra: Partial<ActivityCheckCliDeps> = {}, advanceMs = 15_000) {
    const promise = runCpmmPoolActivityCheckCli(
      ["--pool", POOL, "--out-dir", OUT_REL, "--live"],
      deps(extra),
    );
    return drive(promise, advanceMs);
  }

  return {
    projectRoot,
    sched,
    logs,
    calls,
    get loadCalls() {
      return loadCalls;
    },
    deps,
    drive,
    runLive,
  };
}

function assertNoSecrets(root: string, logs: readonly string[]): void {
  const joinedLogs = logs.join("\n");
  expect(joinedLogs).not.toContain(RPC_KEY);
  expect(joinedLogs).not.toContain(RPC_URL);
  const absOut = path.join(root, ...OUT_REL.split("/"));
  if (existsSync(absOut)) {
    for (const file of readdirSync(absOut)) {
      const content = readFileSync(path.join(absOut, file), "utf8");
      expect(content, file).not.toContain(RPC_KEY);
      expect(content, file).not.toContain(RPC_URL);
    }
  }
}

describe("cpmm-pool-activity-check offline suite", () => {
  it("AC01: module source has no static config/transport imports and main guard distinguishes wrappers", () => {
    const src = readFileSync(path.join(import.meta.dirname, "cpmm-pool-activity-check.ts"), "utf8");
    const staticImports = src
      .split(/\r?\n/)
      .filter((l) => l.startsWith("import ") || l.startsWith("export {"))
      .join("\n");
    expect(staticImports).not.toContain("paper-trading-daemon");
    expect(staticImports).not.toContain("paper-single-candidate-diagnostic");
    expect(staticImports).not.toContain("ws");
    expect(isCpmmActivityCheckMainModule(undefined, import.meta.url)).toBe(false);
    expect(isCpmmActivityCheckMainModule("", import.meta.url)).toBe(false);
    expect(
      isCpmmActivityCheckMainModule(
        path.join(import.meta.dirname, "cpmm-pool-activity-check.ts"),
        pathToFileURL(path.join(import.meta.dirname, "cpmm-pool-activity-check.ts")).href,
      ),
    ).toBe(true);
    expect(isSolanaAddress(POOL)).toBe(true);
    expect(isSolanaAddress("not-a-pool")).toBe(false);
    expect(isSolanaAddress("1".repeat(31))).toBe(false);
  });

  it("AC02: --help and default dry run are inert and print fixed limits and non-certifications", async () => {
    const h = makeHarness();
    const helpRes = await runCpmmPoolActivityCheckCli(["--help"], h.deps());
    expect(helpRes).toMatchObject({ mode: "HELP", exitCode: X.OK });
    expect(h.loadCalls).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(readdirSync(h.projectRoot)).toEqual([]);
    expect(h.logs[0]).toBe(ACTIVITY_CHECK_USAGE);
    const helpPlan = JSON.parse(h.logs[2]!) as ReturnType<typeof buildActivityCheckPlan>;
    expect(helpPlan.limits).toEqual(ACTIVITY_CHECK_LIMITS);
    expect(helpPlan.nonCertifications).toEqual(ACTIVITY_CHECK_NON_CERTIFICATIONS);

    h.logs.length = 0;
    const dryRes = await runCpmmPoolActivityCheckCli(
      ["--pool", POOL, "--out-dir", OUT_REL],
      h.deps(),
    );
    expect(dryRes).toMatchObject({ mode: "DRY_RUN", exitCode: X.OK, outDir: OUT_REL });
    expect(dryRes.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.loadCalls).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(readdirSync(h.projectRoot)).toEqual([]);
    expect(h.logs[0]).toBe(
      "[DRY_RUN] No configuration loaded, no transport opened, nothing sent, nothing written.",
    );
    const dryPlan = JSON.parse(h.logs[4]!) as ReturnType<typeof buildActivityCheckPlan>;
    expect(dryPlan).toMatchObject({
      poolAddress: POOL,
      outDir: OUT_REL,
      mode: "DRY_RUN",
      limits: {
        httpRequests: 1,
        getTransactionCalls: 0,
        dexScreenerCalls: 0,
        webSockets: 0,
        pagination: 0,
        retries: 0,
        redirects: 0,
        automaticObservation: false,
        pageLimit: 20,
        commitment: "confirmed",
        acquisitionDeadlineMs: 10_000,
        requestTimeoutMs: 10_000,
        maxResponseBytes: 65_536,
      },
      request: {
        method: "POST",
        rpcMethod: ACTIVITY_CHECK_RPC_METHOD,
        rpcParams: [POOL, { limit: 20, commitment: "confirmed" }],
      },
    });
  });

  it("AC03: invalid args, existing output dir and bad config refuse before any network or write", async () => {
    const h = makeHarness();
    const badCases: string[][] = [
      [],
      ["--help", "--live"],
      ["--verify", OUT_REL, "--live"],
      ["--verify", OUT_REL, "--pool", POOL],
      ["--verify", ""],
      ["--pool", "bad-address", "--out-dir", OUT_REL],
      ["--pool", POOL, "--out-dir", "data/research/other/dir"],
      ["--pool", POOL, "--out-dir", `${OUT_REL}/nested`],
      ["--pool", POOL, "--pool", POOL, "--out-dir", OUT_REL],
      ["--unknown"],
      ["positional"],
    ];
    for (const args of badCases) {
      await expect(runCpmmPoolActivityCheckCli(args, h.deps())).rejects.toThrow(
        /\[CLI_INVALID_ARG\]/,
      );
    }
    expect(h.loadCalls).toBe(0);
    expect(h.calls).toHaveLength(0);

    // Existing output directory is refused before config load even in dry-run or live.
    mkdirSync(path.join(h.projectRoot, ...OUT_REL.split("/")), { recursive: true });
    await expect(
      runCpmmPoolActivityCheckCli(["--pool", POOL, "--out-dir", OUT_REL, "--live"], h.deps()),
    ).rejects.toThrow(/\[OUTPUT_EXISTS\]/);
    expect(h.loadCalls).toBe(0);

    // Config refusal in --live before fetch.
    const h2 = makeHarness({ env: { SOLANA_RPC_URL: "http://insecure.invalid/?api-key=secret1" } });
    await expect(
      runCpmmPoolActivityCheckCli(["--pool", POOL, "--out-dir", OUT_REL, "--live"], h2.deps()),
    ).rejects.toThrow(/SOLANA_RPC_URL must use https/);
    expect(h2.loadCalls).toBe(1);
    expect(h2.calls).toHaveLength(0);

    const h3 = makeHarness({ env: {} });
    await expect(
      runCpmmPoolActivityCheckCli(["--pool", POOL, "--out-dir", OUT_REL, "--live"], h3.deps()),
    ).rejects.toThrow(/\[MISSING_CONFIGURATION\]/);
    expect(h3.calls).toHaveLength(0);

    // Environment loader exception never echoes arbitrary error text.
    const h4 = makeHarness();
    let caught: unknown;
    try {
      await runCpmmPoolActivityCheckCli(
        ["--pool", POOL, "--out-dir", OUT_REL, "--live"],
        h4.deps({
          loadEnvironment: () => {
            throw new Error(`secret leak ${RPC_KEY}`);
          },
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(printableActivityCheckError(caught)).toBe(
      "[CONFIGURATION_LOAD_FAILED] the configuration loader failed; its error text is withheld",
    );
  });

  it("AC04: empty page is sealed, non-certifying, reproducible offline and exits 0", async () => {
    const h = makeHarness({ fetch: { body: rpcBody([]) } });
    const r = await h.runLive();
    expect(r.exitCode).toBe(X.OK);
    expect(h.loadCalls).toBe(1);
    expect(h.calls).toHaveLength(1);
    const bodySent = JSON.parse(String(h.calls[0]!.init!.body)) as {
      method: string;
      params: unknown[];
    };
    expect(bodySent.method).toBe("getSignaturesForAddress");
    expect(bodySent.params).toEqual([POOL, { limit: 20, commitment: "confirmed" }]);
    expect((r.record!.request as Record<string, unknown>).url).toBe(
      ACTIVITY_CHECK_RPC_URL_PLACEHOLDER,
    );

    const page = r.verification!.computed!.page!;
    expect(page.emptyPage).toBe(true);
    expect(page.potentiallyTruncatedHistory).toBe(false);
    expect(page.counts).toEqual({
      returned: 0,
      succeeded: 0,
      failed: 0,
      nullBlockTime: 0,
      knownBlockTime: 0,
      confirmed: 0,
      finalized: 0,
      distinctSlots: 0,
      maxPerSlot: 0,
      slotsWithMultipleSignatures: 0,
    });
    expect(page.observedTimeSpan).toEqual({
      newestKnownBlockTimeSec: null,
      oldestKnownBlockTimeSec: null,
      spanSec: null,
      newestKnownBlockTimeIso: null,
      oldestKnownBlockTimeIso: null,
      blockTimeOrderAnomaly: false,
    });
    expect(page.slotGrouping).toEqual([]);
    expect(page.nonCertifications).toEqual(ACTIVITY_CHECK_NON_CERTIFICATIONS);

    const vRes = await runCpmmPoolActivityCheckCli(["--verify", OUT_REL], h.deps());
    expect(vRes.exitCode).toBe(X.OK);
    expect(vRes.verification!.integrity.ok).toBe(true);
    expect(vRes.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
    assertNoSecrets(h.projectRoot, h.logs);
  });

  it("AC05: full page (20 records), slot grouping, failed txs, null blockTime, and optional transactionIndex", async () => {
    const staleBase = BASE_SEC - 86_400; // 1 day old
    const records = [
      rec(1, 900, staleBase, { confirmationStatus: "finalized", transactionIndex: 0 }),
      rec(2, 900, null, { err: { InstructionError: [0, { Custom: 6001 }] }, transactionIndex: 4 }),
      rec(3, 900, staleBase, { err: "InstructionError", memo: "[0] test memo" }),
      rec(4, 895, staleBase - 120, { confirmationStatus: "finalized", transactionIndex: 12 }),
      ...Array.from({ length: 16 }, (_, idx) =>
        rec(idx + 5, 890 - idx * 5, staleBase - 200 - idx * 60),
      ),
    ];
    expect(records).toHaveLength(20);
    const h = makeHarness({ fetch: { body: rpcBody(records) } });
    const r = await h.runLive();
    expect(r.exitCode).toBe(X.OK);

    const page = r.verification!.computed!.page!;
    expect(page.emptyPage).toBe(false);
    expect(page.potentiallyTruncatedHistory).toBe(true);
    expect(page.counts).toEqual({
      returned: 20,
      succeeded: 18,
      failed: 2,
      nullBlockTime: 1,
      knownBlockTime: 19,
      confirmed: 18,
      finalized: 2,
      distinctSlots: 18,
      maxPerSlot: 3,
      slotsWithMultipleSignatures: 1,
    });
    expect(page.slotGrouping[0]).toEqual({
      slot: 900,
      count: 3,
      succeeded: 1,
      failed: 2,
      blockTime: null,
      blockTimeMixed: true,
    });
    expect(page.records[0]!.transactionIndex).toBe(0);
    expect(page.records[1]!.transactionIndex).toBe(4);
    expect(page.records[2]!.transactionIndex).toBeNull();
    expect(page.records[2]!.memoPresent).toBe(true);
    expect(page.observedTimeSpan.newestKnownBlockTimeSec).toBe(staleBase);
    expect(page.observedTimeSpan.oldestKnownBlockTimeSec).toBe(staleBase - 200 - 15 * 60);
    expect(page.observedTimeSpan.spanSec).toBe(200 + 15 * 60);
    expect(r.verification!.computed!.newestAgeAtCheckStartSec).toBe(86_400);
    expect(page.nonCertifications).toEqual(ACTIVITY_CHECK_NON_CERTIFICATIONS);

    // Offline verification reproduces exact metadata on a relocated copy too.
    const movedDir = path.join(h.projectRoot, "moved-copy");
    cpSync(path.join(h.projectRoot, ...OUT_REL.split("/")), movedDir, { recursive: true });
    const vMoved = verifyActivityCheckEvidence(movedDir);
    expect(vMoved.integrity.ok).toBe(true);
    expect(vMoved.computed!.page).toEqual(page);
    expect(vMoved.computed!.reanalysisStatus).toBe("REPRODUCED");
    assertNoSecrets(h.projectRoot, h.logs);
  });

  it("AC06: stale all-null-blockTime page keeps spanSec null and preserves limitations", async () => {
    const recs = [rec(1, 400, null), rec(2, 399, null)];
    const h = makeHarness({ fetch: { body: rpcBody(recs) } });
    const r = await h.runLive();
    expect(r.exitCode).toBe(X.OK);
    const page = r.verification!.computed!.page!;
    expect(page.counts).toMatchObject({ returned: 2, nullBlockTime: 2, knownBlockTime: 0 });
    expect(page.observedTimeSpan).toEqual({
      newestKnownBlockTimeSec: null,
      oldestKnownBlockTimeSec: null,
      spanSec: null,
      newestKnownBlockTimeIso: null,
      oldestKnownBlockTimeIso: null,
      blockTimeOrderAnomaly: false,
    });
    expect(r.verification!.computed!.newestAgeAtCheckStartSec).toBeNull();
    expect(r.record!.limitations).toEqual(ACTIVITY_CHECK_LIMITATIONS);
  });

  it("AC07: strict parser validates record shapes, optional transactionIndex and ordering", () => {
    const baseRec = rec(1, 500, BASE_SEC);
    const cases: [string, unknown, string][] = [
      ["invalid utf8", new Uint8Array([0xff, 0xfe]), "INVALID_UTF8"],
      ["not json", Buffer.from("{bad"), "NOT_JSON"],
      [
        "wrong rpc",
        Buffer.from(JSON.stringify({ jsonrpc: "1.0", id: 1, result: [] })),
        "NOT_JSON_RPC_2_0",
      ],
      [
        "wrong id",
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: [] })),
        "RESPONSE_ID_MISMATCH",
      ],
      [
        "too many",
        Buffer.from(rpcBody(Array.from({ length: 21 }, (_, i) => rec(i + 1, 1000 - i, BASE_SEC)))),
        "TOO_MANY_RECORDS",
      ],
      [
        "unknown optional field",
        Buffer.from(rpcBody([{ ...baseRec, unexpectedKey: 1 }])),
        "RECORD_SHAPE_INVALID:0",
      ],
      [
        "null transactionIndex",
        Buffer.from(rpcBody([{ ...baseRec, transactionIndex: null }])),
        "TRANSACTION_INDEX_INVALID:0",
      ],
      [
        "negative transactionIndex",
        Buffer.from(rpcBody([{ ...baseRec, transactionIndex: -1 }])),
        "TRANSACTION_INDEX_INVALID:0",
      ],
      [
        "float transactionIndex",
        Buffer.from(rpcBody([{ ...baseRec, transactionIndex: 1.5 }])),
        "TRANSACTION_INDEX_INVALID:0",
      ],
      [
        "duplicate signature",
        Buffer.from(rpcBody([rec(1, 500, BASE_SEC), rec(1, 499, BASE_SEC - 1)])),
        "DUPLICATE_SIGNATURE:1",
      ],
      [
        "slot order inversion",
        Buffer.from(rpcBody([rec(1, 499, BASE_SEC), rec(2, 500, BASE_SEC + 1)])),
        "NOT_NEWEST_FIRST:1",
      ],
    ];
    for (const [label, bytes, expectedReason] of cases) {
      const buf = bytes instanceof Uint8Array ? bytes : Buffer.from(String(bytes));
      expect(analyzePoolActivityResponse(buf, 1), label).toEqual({
        kind: "MALFORMED",
        reason: expectedReason,
      });
    }
  });

  it("AC08: timeout, oversized (>64 KiB), RPC error, HTTP 500 and credential-bearing transport error exit 3 cleanly", async () => {
    // Request timeout (10 s)
    const hTimeout = makeHarness({ fetch: { delayMs: 12_000 } });
    const rTimeout = await hTimeout.runLive({}, 15_000);
    expect(rTimeout.exitCode).toBe(X.NO_PAGE);
    expect(rTimeout.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(hTimeout.calls).toHaveLength(1); // zero retries
    assertNoSecrets(hTimeout.projectRoot, hTimeout.logs);

    // Oversized body (> 64 KiB cap)
    const bigBody = rpcBody([rec(1, 500, BASE_SEC, { memo: "m".repeat(70_000) })]);
    const hBig = makeHarness({ fetch: { body: bigBody } });
    const rBig = await hBig.runLive();
    expect(rBig.exitCode).toBe(X.NO_PAGE);
    expect(rBig.acquisition!.outcome).toBe("RESPONSE_LIMIT_EXCEEDED");
    expect(rBig.verification!.integrity.ok).toBe(true);
    expect(rBig.verification!.computed!.outcome).toBe("RESPONSE_LIMIT_EXCEEDED");

    // Credential-bearing transport throw & JSON-RPC error
    const hErr = makeHarness({
      fetch: { throwError: `connect ECONNREFUSED ${RPC_URL} ${RPC_KEY}` },
    });
    const rErr = await hErr.runLive();
    expect(rErr.exitCode).toBe(X.NO_PAGE);
    expect(rErr.acquisition!.outcome).toBe("TRANSPORT_ERROR");
    expect(rErr.verification!.integrity.ok).toBe(true);
    assertNoSecrets(hErr.projectRoot, hErr.logs);

    // Clean JSON-RPC error -> reproduced offline, exit 3
    const hRpcClean = makeHarness({
      fetch: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32005, message: "rate limited" },
        }),
      },
    });
    const rRpcClean = await hRpcClean.runLive();
    expect(rRpcClean.exitCode).toBe(X.NO_PAGE);
    expect(rRpcClean.verification!.recorded!.outcome).toBe("RPC_ERROR");
    expect(rRpcClean.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
    expect(rRpcClean.verification!.computed!.rpcError!.code).toBe(-32005);

    // Credential-bearing JSON-RPC error -> redacted in sealed record, UNAVAILABLE_REDACTED computed, exit 3
    const hRpcErr = makeHarness({
      fetch: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32005, message: `limit hit at ${RPC_URL}` },
        }),
      },
    });
    const rRpcErr = await hRpcErr.runLive();
    expect(rRpcErr.exitCode).toBe(X.NO_PAGE);
    expect(rRpcErr.verification!.recorded!.outcome).toBe("RPC_ERROR");
    expect((rRpcErr.record!.recorded as Record<string, unknown>).rpcError).toEqual({
      code: -32005,
      message: "limit hit at [REDACTED]",
    });
    expect(rRpcErr.verification!.computed!.reanalysisStatus).toBe("UNAVAILABLE_REDACTED");
    assertNoSecrets(hRpcErr.projectRoot, hRpcErr.logs);

    // HTTP 500 -> HTTP_ERROR, exit 3
    const hHttp = makeHarness({ fetch: { status: 500, body: "internal error" } });
    const rHttp = await hHttp.runLive();
    expect(rHttp.exitCode).toBe(X.NO_PAGE);
    expect(rHttp.verification!.recorded!.outcome).toBe("HTTP_ERROR");
    expect(rHttp.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
  });

  it("AC09: redacted or withheld 200 OK response keeps recorded, integrity and computed separate and exits 2", async () => {
    // Case A: literal secret inside memo gets redacted in response bytes -> UNAVAILABLE_REDACTED -> exit 2
    const literalLeakBody = rpcBody([rec(1, 500, BASE_SEC, { memo: `leak=${RPC_KEY}` })]);
    const hRedacted = makeHarness({ fetch: { body: literalLeakBody } });
    const rRed = await hRedacted.runLive();
    expect(rRed.exitCode).toBe(X.EVIDENCE_LIMITED);
    expect(rRed.verification!.integrity.ok).toBe(true);
    expect(rRed.verification!.recorded!.outcome).toBe("PAGE_RECEIVED");
    expect(rRed.verification!.recorded!.pageObtained).toBe(true);
    expect(rRed.verification!.computed!.reanalysisStatus).toBe("UNAVAILABLE_REDACTED");
    expect(rRed.verification!.computed!.pageObtained).toBe(false);
    assertNoSecrets(hRedacted.projectRoot, hRedacted.logs);

    // Offline --verify also reports exit 2 and does not leak secrets
    const vRed = await runCpmmPoolActivityCheckCli(["--verify", OUT_REL], hRedacted.deps());
    expect(vRed.exitCode).toBe(X.EVIDENCE_LIMITED);
    expect(vRed.verification!.computed!.reanalysisStatus).toBe("UNAVAILABLE_REDACTED");

    // Case B: percent-encoded secret in JSON triggers WITHHELD by sanitizer -> UNAVAILABLE_WITHHELD -> exit 2
    const encodedSecret = encodeURIComponent(RPC_KEY).replace(
      /./g,
      (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
    const withheldBody = rpcBody([rec(1, 500, BASE_SEC, { memo: encodedSecret })]);
    const hWithheld = makeHarness({ fetch: { body: withheldBody } });
    const rWithheld = await hWithheld.runLive();
    expect(rWithheld.exitCode).toBe(X.EVIDENCE_LIMITED);
    expect(rWithheld.verification!.integrity.ok).toBe(true);
    expect(rWithheld.verification!.computed!.reanalysisStatus).toBe("UNAVAILABLE_WITHHELD");
    expect(rWithheld.verification!.computed!.pageObtained).toBe(false);
    assertNoSecrets(hWithheld.projectRoot, hWithheld.logs);
  });

  it("AC10: cancellation seals intact (exit 6); signal listener install/removal failures are handled", async () => {
    const h = makeHarness({ fetch: { delayMs: 5_000 } });
    const listeners = new Map<ActivityCheckSignal, () => void>();
    const signals = {
      on: (s: ActivityCheckSignal, fn: () => void) => {
        listeners.set(s, fn);
      },
      removeListener: (s: ActivityCheckSignal) => {
        listeners.delete(s);
      },
    };
    const p = runCpmmPoolActivityCheckCli(
      ["--pool", POOL, "--out-dir", OUT_REL, "--live"],
      h.deps({ signals }),
    );
    await new Promise<void>((r) => setImmediate(r));
    await h.sched.runTo(START_MS + 1_000);
    listeners.get("SIGINT")!();
    await h.sched.runTo(START_MS + 15_000);
    const r = await p;
    expect(r.exitCode).toBe(X.CANCELLED);
    expect(r.acquisition!.outcome).toBe("OPERATOR_CANCELLED");
    expect(listeners.size).toBe(0);
    expect(r.verification!.integrity.ok).toBe(true);
    expect(r.verification!.computed!.outcome).toBe("OPERATOR_CANCELLED");
    assertNoSecrets(h.projectRoot, h.logs);

    // Removal failure on clean page elevates exit 0 to CLEANUP_FAILED (7).
    const hClean = makeHarness();
    const badRemove = {
      on: () => {},
      removeListener: (s: ActivityCheckSignal) => {
        if (s === "SIGTERM") throw new Error("remove failed");
      },
    };
    const rClean = await hClean.runLive({ signals: badRemove });
    expect(rClean.exitCode).toBe(X.CLEANUP_FAILED);
    expect(rClean.signalCleanupFailures).toEqual(["SIGNAL_REMOVE_FAILED:SIGTERM"]);

    // Install failure aborts before fetch.
    const hInst = makeHarness();
    await expect(
      runCpmmPoolActivityCheckCli(
        ["--pool", POOL, "--out-dir", OUT_REL, "--live"],
        hInst.deps({
          signals: {
            on: () => {
              throw new Error("install failed");
            },
            removeListener: () => {},
          },
        }),
      ),
    ).rejects.toThrow(/\[SIGNAL_INSTALL_FAILED\]/);
    expect(hInst.calls).toHaveLength(0);
  });

  it("AC11: write failure and credential-bearing write errors exit 5 with no secrets leaked", async () => {
    const h = makeHarness();
    const r = await h.runLive({
      writeFile: () => {
        throw new Error(`disk full at ${RPC_URL}`);
      },
    });
    expect(r.exitCode).toBe(X.SEAL_FAILED);
    expect(r.seal).toMatchObject({ ok: false, status: "ARTIFACT_WRITE_FAILED" });
    assertNoSecrets(h.projectRoot, h.logs);
  });

  it("AC12: offline verify catches file tampering, manifest tampering, unlisted files and outcome mismatch", async () => {
    const h = makeHarness();
    const r = await h.runLive();
    expect(r.exitCode).toBe(X.OK);
    const absOut = path.join(h.projectRoot, ...OUT_REL.split("/"));

    const copyBundle = () => {
      const copyDir = mkdtempSync(path.join(os.tmpdir(), "cpmm-activity-copy-"));
      roots.push(copyDir);
      cpSync(absOut, copyDir, { recursive: true });
      return copyDir;
    };

    // Unlisted file fails closed
    const unlistedDir = copyBundle();
    writeFileSync(path.join(unlistedDir, "extra.txt"), "x");
    const vUnlisted = verifyActivityCheckEvidence(unlistedDir);
    expect(vUnlisted.integrity.ok).toBe(false);
    expect(vUnlisted.integrity.problems).toContain("UNLISTED:extra.txt");
    const cliUnlisted = await runCpmmPoolActivityCheckCli(["--verify", unlistedDir], h.deps());
    expect(cliUnlisted.exitCode).toBe(X.INTEGRITY_FAILED);

    // Tampered activity.json fails digest check
    const tamperedDir = copyBundle();
    const actPath = path.join(tamperedDir, ACTIVITY_CHECK_FILES.activity);
    writeFileSync(actPath, readFileSync(actPath, "utf8") + "\n");
    const vTampered = verifyActivityCheckEvidence(tamperedDir);
    expect(vTampered.integrity.ok).toBe(false);
    expect(vTampered.integrity.problems).toContain(`MODIFIED:${ACTIVITY_CHECK_FILES.activity}`);

    // Rewritten activity + recomputed hash pretending a different recorded outcome is caught by computed check
    const forgedDir = copyBundle();
    const act = JSON.parse(
      readFileSync(path.join(forgedDir, ACTIVITY_CHECK_FILES.activity), "utf8"),
    ) as Record<string, unknown>;
    (act.recorded as Record<string, unknown>).outcome = "RPC_ERROR";
    (act.recorded as Record<string, unknown>).pageObtained = false;
    const forgedText = JSON.stringify(act, null, 2) + "\n";
    writeFileSync(path.join(forgedDir, ACTIVITY_CHECK_FILES.activity), forgedText);
    const man = JSON.parse(
      readFileSync(path.join(forgedDir, ACTIVITY_CHECK_FILES.manifest), "utf8"),
    ) as {
      recordedOutcome: unknown;
      recordedPageObtained: unknown;
      files: { path: string; sha256: string; bytes: number }[];
    };
    man.recordedOutcome = "RPC_ERROR";
    man.recordedPageObtained = false;
    man.files[1] = {
      path: ACTIVITY_CHECK_FILES.activity,
      sha256: createHash("sha256").update(forgedText).digest("hex"),
      bytes: Buffer.byteLength(forgedText, "utf8"),
    };
    writeFileSync(
      path.join(forgedDir, ACTIVITY_CHECK_FILES.manifest),
      JSON.stringify(man, null, 2) + "\n",
    );
    const vForged = verifyActivityCheckEvidence(forgedDir);
    expect(vForged.integrity.ok).toBe(false);
    expect(vForged.integrity.problems).toContain("OUTCOME_NOT_REPRODUCED");
    expect(vForged.computed!.reanalysisStatus).toBe("MISMATCH");
  });

  it("AC13: child-process CLI execution exits cleanly with no secrets and exact exit codes", () => {
    const tsx = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
    const script = path.resolve(import.meta.dirname, "cpmm-pool-activity-check.ts");
    const helpProc = spawnSync(process.execPath, [tsx, script, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(helpProc.status).toBe(X.OK);
    expect(helpProc.stdout).toContain("CPMM_POOL_ACTIVITY_CHECK_PLAN");

    const badProc = spawnSync(process.execPath, [tsx, script, "--pool", "bad-secret-value"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(badProc.status).toBe(X.INVALID);
    expect(badProc.stderr).toContain("[CLI_INVALID_ARG]");
    expect(badProc.stderr).not.toContain("bad-secret-value");
  });

  it("AC14 (defect 1): positional credential URL and unknown secret options never echo in printable error or CLI output", async () => {
    const h = makeHarness();
    const cases: string[][] = [[RPC_URL], [`--unknown-${RPC_KEY}`, "x"], [`--url=${RPC_URL}`]];
    for (const argv of cases) {
      let thrown: unknown;
      try {
        await runCpmmPoolActivityCheckCli(argv, h.deps());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const printable = printableActivityCheckError(thrown);
      expect(printable).toBe("[CLI_INVALID_ARG] unknown, malformed or positional argument");
      expect(printable).not.toContain(RPC_KEY);
      expect(printable).not.toContain(RPC_URL);
      expect(printable).not.toContain("synthetic.invalid");
    }

    const tsx = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
    const script = path.resolve(import.meta.dirname, "cpmm-pool-activity-check.ts");
    const posProc = spawnSync(process.execPath, [tsx, script, RPC_URL], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(posProc.status).toBe(X.INVALID);
    expect(posProc.stderr).not.toContain(RPC_KEY);
    expect(posProc.stderr).not.toContain(RPC_URL);
    expect(posProc.stderr).toContain("[CLI_INVALID_ARG] unknown, malformed or positional argument");
  });

  it("AC15 (defect 2): absolute acquisition deadline refuses dispatch at/after t0+10000 and bounds in-flight work by remaining time", async () => {
    // First reading returns t0; subsequent readings return t0 + 10_000 (right at declared deadline).
    const h = makeHarness();
    let clockReads = 0;
    const jumpClock = () => (clockReads++ === 0 ? START_MS : START_MS + 10_000);
    const rExpired = await h.drive(
      runCpmmPoolActivityCheckCli(
        ["--pool", POOL, "--out-dir", OUT_REL, "--live"],
        h.deps({ clock: jumpClock }),
      ),
    );
    expect(h.calls).toHaveLength(0);
    expect(rExpired.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect((rExpired.record!.request as Record<string, unknown>).dispatchedAtMs).toBeNull();
    expect(rExpired.verification!.integrity.ok).toBe(true);
    expect(rExpired.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
    expect(rExpired.verification!.computed!.outcome).toBe("DEADLINE_EXPIRED");
    expect(rExpired.exitCode).toBe(X.NO_PAGE);

    // Partial startup elapsed time (6,000 ms spent before open) bounds in-flight fetch to remaining 4,000 ms.
    const h2 = makeHarness({ fetch: { delayMs: 6_000 } });
    const out2 = "data/research/cpmm-activity-checks/check-partial-deadline";
    let readCount = 0;
    const partialClock = () => {
      readCount++;
      if (readCount === 1) return START_MS;
      return Math.max(START_MS + 6_000, h2.sched.now);
    };
    const r2 = await h2.drive(
      runCpmmPoolActivityCheckCli(
        ["--pool", POOL, "--out-dir", out2, "--live"],
        h2.deps({ clock: partialClock }),
      ),
    );
    expect(h2.calls).toHaveLength(1);
    expect(r2.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(r2.acquisition!.endedAtMs).toBeLessThanOrEqual(START_MS + 10_000);
    expect(r2.verification!.integrity.ok).toBe(true);
    expect(r2.exitCode).toBe(X.NO_PAGE);

    // Clock jumps to t0 + 10_000 right at dispatch refusal check (read 1 = t0, read 2 = t0 + 1, read 3+ = t0 + 10_000).
    const h3 = makeHarness();
    let reads3 = 0;
    const dispatchJumpClock = () => {
      reads3++;
      if (reads3 === 1) return START_MS;
      if (reads3 === 2) return START_MS + 1;
      return START_MS + 10_000;
    };
    const r3 = await h3.drive(
      runCpmmPoolActivityCheckCli(
        [
          "--pool",
          POOL,
          "--out-dir",
          "data/research/cpmm-activity-checks/check-dispatch-jump",
          "--live",
        ],
        h3.deps({ clock: dispatchJumpClock }),
      ),
    );
    expect(h3.calls).toHaveLength(0);
    expect(r3.acquisition!.outcome).toBe("DEADLINE_EXPIRED");
    expect(r3.verification!.integrity.ok).toBe(true);
    expect(r3.exitCode).toBe(X.NO_PAGE);
  });

  it("AC16 (defect 3): blockTime MAX_SAFE_INTEGER and 7500-nested err objects seal bounded MALFORMED_RESPONSE instead of throwing", async () => {
    // 3a: blockTime = Number.MAX_SAFE_INTEGER overflows JS Date ISO conversion (< 64 KiB body)
    const maxBtBody = rpcBody([rec(1, 500, Number.MAX_SAFE_INTEGER)]);
    expect(Buffer.byteLength(maxBtBody, "utf8")).toBeLessThan(65_536);
    const hBt = makeHarness({ fetch: { body: maxBtBody } });
    const rBt = await hBt.runLive();
    expect(rBt.exitCode).toBe(X.NO_PAGE);
    expect(rBt.seal!.ok).toBe(true);
    expect(rBt.verification!.integrity.ok).toBe(true);
    expect(rBt.verification!.recorded!.outcome).toBe("MALFORMED_RESPONSE");
    expect(rBt.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
    expect(rBt.verification!.computed!.outcome).toBe("MALFORMED_RESPONSE");

    // 3b: ~7500 nested {"x":...} error structure (< 64 KiB body)
    const nestedErr = `${'{"x":'.repeat(7500)}0${"}".repeat(7500)}`;
    const deepBody =
      `{"jsonrpc":"2.0","id":1,"result":[{"signature":${JSON.stringify(sig(1))},` +
      `"slot":500,"err":${nestedErr},"memo":null,"blockTime":${BASE_SEC},"confirmationStatus":"confirmed"}]}`;
    expect(Buffer.byteLength(deepBody, "utf8")).toBeLessThan(65_536);
    const hDeep = makeHarness({ fetch: { body: deepBody } });
    const rDeep = await hDeep.runLive();
    expect(rDeep.exitCode).toBe(X.NO_PAGE);
    expect(rDeep.seal!.ok).toBe(true);
    expect(rDeep.verification!.integrity.ok).toBe(true);
    expect(rDeep.verification!.recorded!.outcome).toBe("MALFORMED_RESPONSE");
    expect(rDeep.verification!.computed!.reanalysisStatus).toBe("REPRODUCED");
    expect(rDeep.verification!.computed!.outcome).toBe("MALFORMED_RESPONSE");

    // 3c: ordinary error objects and exact 65536-byte boundary remain accepted cleanly
    const ordinaryErrBody = rpcBody([
      rec(1, 500, BASE_SEC, { err: { InstructionError: [0, { Custom: 6001 }] } }),
    ]);
    const hOrd = makeHarness({ fetch: { body: ordinaryErrBody } });
    const rOrd = await hOrd.runLive();
    expect(rOrd.exitCode).toBe(X.OK);
    expect(rOrd.verification!.computed!.page!.counts.failed).toBe(1);

    const overhead = rpcBody([rec(1, 500, BASE_SEC, { memo: "" })]).length;
    const exact64kBody = rpcBody([rec(1, 500, BASE_SEC, { memo: "a".repeat(65_536 - overhead) })]);
    expect(Buffer.byteLength(exact64kBody, "utf8")).toBe(65_536);
    const h64k = makeHarness({ fetch: { body: exact64kBody } });
    const r64k = await h64k.runLive();
    expect(r64k.exitCode).toBe(X.OK);
    expect(r64k.verification!.integrity.ok).toBe(true);
  });

  it("AC17 (defect 4): verifier rejects symlinked manifest/artifacts and oversized files BEFORE reading contents", async () => {
    const h = makeHarness();
    const r = await h.runLive();
    expect(r.exitCode).toBe(X.OK);
    const absOut = path.join(h.projectRoot, ...OUT_REL.split("/"));

    const copyBundle = () => {
      const copyDir = mkdtempSync(path.join(os.tmpdir(), "cpmm-activity-sym-"));
      roots.push(copyDir);
      cpSync(absOut, copyDir, { recursive: true });
      return copyDir;
    };

    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "cpmm-activity-outside-"));
    roots.push(outsideDir);
    const outsideManifest = path.join(outsideDir, "outside-manifest.json");
    writeFileSync(outsideManifest, readFileSync(path.join(absOut, ACTIVITY_CHECK_FILES.manifest)));
    const outsideActivity = path.join(outsideDir, "outside-activity.json");
    writeFileSync(outsideActivity, '{"tampered":true}\n');

    const reads: string[] = [];
    const spyRead = (filePath: string) => {
      reads.push(filePath);
      return readFileSync(filePath);
    };

    // 4a: Symlinked manifest is rejected before reading (zero bytes read, manifestSha256 null)
    const linkedManifestDir = copyBundle();
    unlinkSync(path.join(linkedManifestDir, ACTIVITY_CHECK_FILES.manifest));
    symlinkSync(outsideManifest, path.join(linkedManifestDir, ACTIVITY_CHECK_FILES.manifest));
    reads.length = 0;
    const vLinkedManifest = verifyActivityCheckEvidence(linkedManifestDir, { readFile: spyRead });
    expect(vLinkedManifest.integrity.ok).toBe(false);
    expect(vLinkedManifest.manifestSha256).toBeNull();
    expect(reads).toEqual([]);

    // 4b: Symlinked activity.json stops before ANY file read (zero reads, never reports MODIFIED:activity.json)
    const linkedActivityDir = copyBundle();
    unlinkSync(path.join(linkedActivityDir, ACTIVITY_CHECK_FILES.activity));
    symlinkSync(outsideActivity, path.join(linkedActivityDir, ACTIVITY_CHECK_FILES.activity));
    reads.length = 0;
    const vLinkedActivity = verifyActivityCheckEvidence(linkedActivityDir, { readFile: spyRead });
    expect(vLinkedActivity.integrity.ok).toBe(false);
    expect(vLinkedActivity.integrity.problems).not.toContain(
      `MODIFIED:${ACTIVITY_CHECK_FILES.activity}`,
    );
    expect(reads).toEqual([]);

    // 4c: Hard-linked activity.json also rejected before any file read
    const hardLinkedDir = copyBundle();
    linkSync(
      path.join(hardLinkedDir, ACTIVITY_CHECK_FILES.activity),
      path.join(outsideDir, "hardlinked-activity.json"),
    );
    reads.length = 0;
    const vHard = verifyActivityCheckEvidence(hardLinkedDir, { readFile: spyRead });
    expect(vHard.integrity.ok).toBe(false);
    expect(vHard.integrity.problems).not.toContain(`MODIFIED:${ACTIVITY_CHECK_FILES.activity}`);
    expect(reads).toEqual([]);

    // 4d: Oversized manifest (>64 KiB) or oversized artifact (>512 KiB) stops before any file read
    const hugeManifestDir = copyBundle();
    writeFileSync(path.join(hugeManifestDir, ACTIVITY_CHECK_FILES.manifest), "x".repeat(70_000));
    reads.length = 0;
    const vHuge = verifyActivityCheckEvidence(hugeManifestDir, { readFile: spyRead });
    expect(vHuge.integrity.ok).toBe(false);
    expect(vHuge.manifestSha256).toBeNull();
    expect(reads).toEqual([]);

    const hugeActivityDir = copyBundle();
    writeFileSync(path.join(hugeActivityDir, ACTIVITY_CHECK_FILES.activity), "x".repeat(600_000));
    reads.length = 0;
    const vHugeActivity = verifyActivityCheckEvidence(hugeActivityDir, { readFile: spyRead });
    expect(vHugeActivity.integrity.ok).toBe(false);
    expect(reads).toEqual([]);
  });
});
