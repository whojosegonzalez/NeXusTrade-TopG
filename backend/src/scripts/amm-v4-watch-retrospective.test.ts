/**
 * Retrospective metadata check for watch 02 (offline). Every dependency is injected and SYNTHETIC:
 * a scripted fetch on the shared virtual scheduler and an injected watch binding. Artifacts are
 * written only into this test's own OS temporary directories. No real network, provider request,
 * credential or socket. One test reads the real sealed watch 02 evidence read-only when present.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  RETROSPECTIVE_BINDING,
  RETROSPECTIVE_EXIT_CODES,
  RETROSPECTIVE_FILES,
  RETROSPECTIVE_LIMITATIONS,
  RETROSPECTIVE_LIMITS,
  RETROSPECTIVE_RPC_PARAMS,
  RETROSPECTIVE_USAGE,
  analyzeSignaturesResponse,
  bindWatchRun,
  printableRetrospectiveError,
  runRetrospectiveCheck,
  timeClassOf,
  verifyRetrospectiveEvidence,
  type RetrospectiveDeps,
  type RetrospectiveRunResult,
  type WatchBinding,
} from "./amm-v4-watch-retrospective.js";
import { RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION } from "./fresh-amm-v4-precheck.js";
import { START_MS, VirtualScheduler, drive, sig } from "./fresh-amm-v4-precheck.test-support.js";

type Loose = ReturnType<typeof JSON.parse>;

const RPC_KEY = "SYNTHETIC-retro-rpc-key-97531";
const RPC_URL = `https://rpc.synthetic.invalid/?api-key=${RPC_KEY}`;
const SECRETS = [RPC_URL, RPC_KEY];
const ENV = Object.freeze({ SOLANA_RPC_URL: RPC_URL });
const RUN = "data/research/retrospective-checks/retro-01";
const START_SEC = 1_794_829_420;
const END_SEC = 1_794_830_320;

const OK_BINDING: WatchBinding = Object.freeze({
  ok: true,
  problems: [],
  manifestSha256: RETROSPECTIVE_BINDING.manifestSha256,
  intervalStartMs: RETROSPECTIVE_BINDING.intervalStartMs,
  intervalEndMs: RETROSPECTIVE_BINDING.intervalEndMs,
});

interface Rec {
  signature?: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
  memo?: string | null;
  confirmationStatus?: string;
}
const rec = (n: number, slot: number, blockTime: number | null, extra: Partial<Rec> = {}) => ({
  signature: sig(n),
  slot,
  err: null,
  memo: null,
  blockTime,
  confirmationStatus: "confirmed",
  ...extra,
});
const withoutMemo = (r: Record<string, unknown>) => {
  const copy = { ...r };
  delete copy.memo;
  return copy;
};
const page = (records: unknown[], id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: records });

/** A page reaching back past the interval with two records inside it. */
const SPANNING = [
  rec(1, 400, END_SEC + 120),
  rec(2, 390, END_SEC - 10),
  rec(3, 380, START_SEC + 30),
  rec(4, 370, START_SEC - 60),
];

// ---------------------------------------------------------------------------------------------
// SYNTHETIC fetch and harness
// ---------------------------------------------------------------------------------------------

interface FetchScript {
  status?: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
  delayMs?: number;
  throwError?: string;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function harness(
  o: { fetch?: FetchScript; env?: Record<string, string | undefined>; binding?: WatchBinding } = {},
) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "retrospective-test-"));
  roots.push(projectRoot);
  const sched = new VirtualScheduler(START_MS);
  const lines: string[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const controller = new AbortController();
  let loads = 0;
  let bindings = 0;
  const f = o.fetch ?? { body: page(SPANNING) };
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    await new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), f.delayMs ?? 100, "harness");
      init?.signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    if (f.throwError !== undefined) throw new Error(f.throwError);
    const body = f.body ?? page(SPANNING);
    return new Response(typeof body === "string" ? body : new Uint8Array(body), {
      status: f.status ?? 200,
      headers: { "content-type": "application/json", ...f.headers },
    });
  }) as unknown as typeof fetch;
  const deps = (extra: Partial<RetrospectiveDeps> = {}): RetrospectiveDeps => ({
    env: o.env ?? ENV,
    loadEnvironment: () => {
      loads++;
    },
    fetchFn,
    clock: () => sched.now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    },
    projectRoot,
    signal: controller.signal,
    log: (line: string) => lines.push(line),
    bindWatch: () => {
      bindings++;
      return o.binding ?? OK_BINDING;
    },
    ...extra,
  });
  const run = (args: readonly string[], extra: Partial<RetrospectiveDeps> = {}) =>
    drive(sched, runRetrospectiveCheck(args, deps(extra)));
  const abs = (rel: string) => path.join(projectRoot, ...rel.split("/"));
  return {
    projectRoot,
    sched,
    lines,
    calls,
    controller,
    loads: () => loads,
    bindings: () => bindings,
    run,
    abs,
  };
}
type Harness = ReturnType<typeof harness>;

const live = (h: Harness, extra: Partial<RetrospectiveDeps> = {}) =>
  h.run(["--out-dir", RUN, "--live"], extra);
const recordJson = (h: Harness): Loose =>
  JSON.parse(readFileSync(path.join(h.abs(RUN), RETROSPECTIVE_FILES.retrospective), "utf8"));

function expectNoSecrets(h: Harness) {
  for (const line of h.lines) for (const s of SECRETS) expect(line.includes(s), line).toBe(false);
  if (!existsSync(h.abs(RUN))) return;
  for (const f of readdirSync(h.abs(RUN))) {
    const text = readFileSync(path.join(h.abs(RUN), f), "utf8");
    for (const s of SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
  }
  const resp = recordJson(h).response;
  if (resp?.storedEncoding === "base64") {
    const bytes = Buffer.from(resp.payload as string, "base64");
    for (const s of SECRETS) expect(bytes.includes(Buffer.from(s))).toBe(false);
  }
}

function expectSettled(h: Harness, r: RetrospectiveRunResult) {
  expect(h.sched.count("provider")).toBe(0);
  expect(h.calls.length).toBeLessThanOrEqual(1);
  void r;
}

/** Rewrites retrospective.json (with its manifest entry and summary) consistently, then verifies. */
function reforge(h: Harness, name: string, edit: (r: Loose) => void) {
  const dir = path.join(h.projectRoot, "data/research/retrospective-checks", name);
  cpSync(h.abs(RUN), dir, { recursive: true });
  const file = path.join(dir, RETROSPECTIVE_FILES.retrospective);
  const r = JSON.parse(readFileSync(file, "utf8")) as Loose;
  edit(r);
  const text = JSON.stringify(r, null, 2) + "\n";
  writeFileSync(file, text);
  const manifestPath = path.join(dir, RETROSPECTIVE_FILES.manifest);
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Loose;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    m.outcome = r.outcome;
    m.pageObtained = r.pageObtained;
  }
  const entry = m.files.find((x: Loose) => x.path === RETROSPECTIVE_FILES.retrospective);
  entry.sha256 = createHash("sha256").update(text).digest("hex");
  entry.bytes = Buffer.byteLength(text);
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  return verifyRetrospectiveEvidence(dir);
}

const analyze = (records: unknown[]) => {
  const a = analyzeSignaturesResponse(Buffer.from(page(records)), 1);
  if (a.kind !== "PAGE") throw new Error(`not a page: ${JSON.stringify(a)}`);
  return a.page;
};

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("AMM v4 watch 02 retrospective metadata check (offline)", () => {
  it("R-01: help, dry run and verify are inert; the plan is bound to watch 02; conflicts are refused", async () => {
    const h = harness();
    expect(await h.run(["--help"])).toMatchObject({ mode: "HELP", exitCode: 0 });
    expect(h.lines[0]).toBe(RETROSPECTIVE_USAGE);
    expect(await h.run(["--out-dir", RUN])).toMatchObject({ mode: "DRY_RUN", exitCode: 0 });
    const plan = JSON.parse(h.lines.at(-1)!) as Loose;
    expect(plan).toMatchObject({
      kind: "PAPER_AMM_V4_WATCH_RETROSPECTIVE_PLAN",
      binding: {
        watchRun: "data/research/prechecks/fresh-amm-v4-watch-02",
        manifestSha256: "9da4be7556cdcbd4db653f0483c8c28a425b5d1aff49f8cac06e178ddb827c99",
        intervalStartMs: 1794829420030,
        intervalEndMs: 1794830320054,
        address: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
      },
      request: {
        rpcMethod: "getSignaturesForAddress",
        rpcParams: [
          "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
          { limit: 20, commitment: "confirmed" },
        ],
      },
    });
    expect(RETROSPECTIVE_BINDING.address).toBe(RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION);
    expect(RETROSPECTIVE_LIMITS).toEqual({
      httpRequests: 1,
      getTransactionCalls: 0,
      webSockets: 0,
      pagination: 0,
      retries: 0,
      redirects: 0,
      pageLimit: 20,
      commitment: "confirmed",
      acquisitionDeadlineMs: 10_000,
      requestTimeoutMs: 10_000,
      maxResponseBytes: 65_536,
    });
    expect(await h.run(["--verify", RUN])).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED,
    });
    expect(h.loads()).toBe(0);
    expect(h.bindings()).toBe(0);
    expect(h.calls).toEqual([]);
    expect(readdirSync(h.projectRoot)).toEqual([]);
    for (const args of [
      ["--help", "--live"],
      ["--verify", RUN, "--live"],
      ["--verify", RUN, "--out-dir", RUN],
      ["--live"],
      [],
      ["--out-dir", RUN, "--out-dir", RUN],
      ["--out-dir", RUN, "x"],
      ["--out-dir", RUN, "--paginate"],
      ["--verify", "data/research/prechecks/x"],
    ]) {
      await expect(h.run(args), args.join(" ")).rejects.toThrow(/^\[CLI_INVALID_ARG\]/);
    }
  });

  it("R-02: output, watch binding and configuration are checked before any request", async () => {
    const h = harness();
    for (const out of [
      "data/research/prechecks/r",
      "data/research/retrospective-checks",
      `${RUN}/x`,
      "../x",
    ]) {
      await expect(h.run(["--out-dir", out, "--live"]), out).rejects.toThrow(
        /^\[CLI_INVALID_ARG\]/,
      );
    }
    mkdirSync(h.abs(RUN), { recursive: true });
    await expect(live(h)).rejects.toThrow(/^\[OUTPUT_EXISTS\]/);
    expect(h.bindings()).toBe(0);
    // A binding failure stops before configuration is loaded.
    const unbound = harness({
      binding: { ...OK_BINDING, ok: false, problems: ["WATCH_MANIFEST_MISMATCH"] },
    });
    const err = await live(unbound).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^\[WATCH_BINDING_FAILED\].*WATCH_MANIFEST_MISMATCH/);
    expect(printableRetrospectiveError(err)).toBe((err as Error).message);
    expect(unbound.loads()).toBe(0);
    expect(unbound.calls).toEqual([]);
    // The real binding check against a project without the watch evidence.
    const missing = bindWatchRun(h.projectRoot);
    expect(missing.ok).toBe(false);
    expect(missing.problems).toEqual(
      expect.arrayContaining([
        "WATCH_EVIDENCE_INTEGRITY_FAILED",
        "WATCH_MANIFEST_MISMATCH",
        "WATCH_INTERVAL_MISMATCH",
      ]),
    );
    // Configuration.
    for (const env of [{}, { SOLANA_RPC_URL: "ws://x" }, { SOLANA_RPC_URL: "http://" }]) {
      const c = harness({ env });
      await expect(live(c)).rejects.toThrow(/^\[MISSING_CONFIGURATION\] SOLANA_RPC_URL/);
      expect(c.calls).toEqual([]);
      expect(readdirSync(c.projectRoot)).toEqual([]);
    }
    // Only the HTTP endpoint is used: an Alchemy RPC host without SOLANA_WS_URL is acceptable here.
    const alchemyUrl = "https://solana-mainnet.g.alchemy.com/v2/SYNTHETIC-alchemy-key-2468";
    const alchemy = harness({ env: { SOLANA_RPC_URL: alchemyUrl } });
    const a = await live(alchemy);
    expect(a.exitCode).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    expect(alchemy.calls.map((c) => c.url)).toEqual([alchemyUrl]);
    expect(
      readFileSync(path.join(alchemy.abs(RUN), RETROSPECTIVE_FILES.retrospective), "utf8"),
    ).not.toContain("SYNTHETIC-alchemy-key-2468");
  });

  const realRoot = fileURLToPath(new URL("../../../", import.meta.url));
  it.skipIf(!existsSync(path.join(realRoot, RETROSPECTIVE_BINDING.watchRun)))(
    "R-02b: the real sealed watch 02 evidence satisfies the binding (read-only)",
    () => {
      expect(bindWatchRun(realRoot)).toEqual(OK_BINDING);
    },
  );

  it("R-03: one request, exactly as planned; a page with interval records is sealed and verified", async () => {
    const h = harness();
    const r = await live(h);
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.OK,
      acquisition: { outcome: "PAGE_RECEIVED", cancelled: false, requestId: 1 },
      seal: { ok: true },
      verification: {
        integrity: { ok: true },
        outcome: "PAGE_RECEIVED",
        pageObtained: true,
        observation: "INTERVAL_RECORDS_IN_PAGE",
      },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(RPC_URL);
    expect(h.calls[0]!.init?.redirect).toBe("manual");
    expect(JSON.parse(String(h.calls[0]!.init?.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [
        "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
        { limit: 20, commitment: "confirmed" },
      ],
    });
    const rec0 = recordJson(h);
    expect(rec0).toMatchObject({
      kind: "PAPER_AMM_V4_WATCH_RETROSPECTIVE",
      binding: RETROSPECTIVE_BINDING,
      bindingCheck: OK_BINDING,
      limitations: [...RETROSPECTIVE_LIMITATIONS],
      request: {
        rpcParams: [
          ...RETROSPECTIVE_RPC_PARAMS.slice(0, 1),
          { limit: 20, commitment: "confirmed" },
        ],
      },
      page: {
        counts: {
          returned: 4,
          afterInterval: 1,
          insideInterval: 2,
          beforeInterval: 1,
          unknownTime: 0,
        },
        coverage: "PAGE_SPANS_INTERVAL",
        observation: "INTERVAL_RECORDS_IN_PAGE",
        fullPage: false,
      },
      pageObtained: true,
    });
    // The schema carries no watch completion or target selection.
    expect(Object.keys(rec0)).not.toEqual(expect.arrayContaining(["target"]));
    expect(JSON.stringify(rec0)).not.toMatch(/"selected"|"target"|"watchCompleted"/);
    expect(readdirSync(h.abs(RUN)).sort()).toEqual([
      "evidence-manifest.json",
      "plan.json",
      "retrospective.json",
    ]);
    expect((await h.run(["--verify", RUN])).exitCode).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    expectNoSecrets(h);
    expectSettled(h, r);
  });

  it("R-04: the page/interval relationship is reported for this page only", () => {
    expect(START_SEC).toBe(Math.floor(RETROSPECTIVE_BINDING.intervalStartMs / 1000));
    expect(END_SEC).toBe(Math.floor(RETROSPECTIVE_BINDING.intervalEndMs / 1000));
    // Newer than the interval: the single page did not reach back.
    const newer = analyze([rec(1, 30, END_SEC + 50), rec(2, 20, END_SEC + 1)]);
    expect(newer).toMatchObject({
      coverage: "PAGE_NEWER_THAN_INTERVAL",
      observation: "COVERAGE_INCONCLUSIVE",
      observationReasons: ["PAGE_NEWER_THAN_INTERVAL"],
    });
    // Older than the interval: the newest returned record predates it.
    const older = analyze([rec(1, 30, START_SEC - 1), rec(2, 20, START_SEC - 500)]);
    expect(older).toMatchObject({
      coverage: "PAGE_OLDER_THAN_INTERVAL",
      observation: "NO_INTERVAL_RECORDS_IN_PAGE",
    });
    // Spanning with nothing inside.
    const gap = analyze([rec(1, 30, END_SEC + 5), rec(2, 20, START_SEC - 5)]);
    expect(gap).toMatchObject({
      coverage: "PAGE_SPANS_INTERVAL",
      observation: "NO_INTERVAL_RECORDS_IN_PAGE",
    });
    // Partial overlap: the oldest returned record is inside the interval.
    const partial = analyze([rec(1, 30, END_SEC + 5), rec(2, 20, START_SEC + 100)]);
    expect(partial).toMatchObject({
      coverage: "PAGE_PARTIALLY_OVERLAPS_INTERVAL",
      observation: "INTERVAL_RECORDS_IN_PAGE",
    });
    // Empty page and a full page.
    expect(analyze([])).toMatchObject({
      coverage: "EMPTY_PAGE",
      observation: "COVERAGE_INCONCLUSIVE",
      fullPage: false,
    });
    const full = analyze(
      Array.from({ length: 20 }, (_, i) => rec(i + 1, 1000 - i, END_SEC + 100 - i)),
    );
    expect(full).toMatchObject({
      fullPage: true,
      coverage: "PAGE_NEWER_THAN_INTERVAL",
      observation: "COVERAGE_INCONCLUSIVE",
    });
  });

  it("R-05: null and boundary block times are kept apart from the interval", () => {
    expect(timeClassOf(START_SEC - 1)).toBe("BEFORE_INTERVAL");
    expect(timeClassOf(START_SEC)).toBe("BOUNDARY_START");
    expect(timeClassOf(START_SEC + 1)).toBe("INSIDE_INTERVAL");
    expect(timeClassOf(END_SEC - 1)).toBe("INSIDE_INTERVAL");
    expect(timeClassOf(END_SEC)).toBe("BOUNDARY_END");
    expect(timeClassOf(END_SEC + 1)).toBe("AFTER_INTERVAL");
    expect(timeClassOf(null)).toBe("UNKNOWN_TIME");
    const boundary = analyze([
      rec(1, 30, END_SEC),
      rec(2, 20, START_SEC),
      rec(3, 10, START_SEC - 9),
    ]);
    expect(boundary).toMatchObject({
      counts: { boundaryStart: 1, boundaryEnd: 1, insideInterval: 0 },
      observation: "BOUNDARY_RECORDS_ONLY",
      observationReasons: ["BOUNDARY_AMBIGUOUS"],
    });
    const nulls = analyze([rec(1, 30, END_SEC + 5), rec(2, 20, null), rec(3, 10, START_SEC - 5)]);
    expect(nulls).toMatchObject({
      counts: { unknownTime: 1 },
      coverage: "PAGE_SPANS_INTERVAL",
      observation: "COVERAGE_INCONCLUSIVE",
      observationReasons: ["NULL_BLOCK_TIME"],
    });
    expect(analyze([rec(1, 30, null)])).toMatchObject({
      coverage: "COVERAGE_UNKNOWN",
      observation: "COVERAGE_INCONCLUSIVE",
    });
    // An inside record with a null-time record still reports both.
    const both = analyze([rec(1, 30, START_SEC + 10), rec(2, 20, null)]);
    expect(both.observationReasons).toEqual(["NULL_BLOCK_TIME"]);
    // Block times out of order with slots are reported, not hidden.
    expect(
      analyze([rec(1, 30, START_SEC + 5), rec(2, 20, START_SEC + 50)]).blockTimeOrderAnomaly,
    ).toBe(true);
  });

  it("R-06: failed-transaction metadata is recorded as address activity, nothing more", async () => {
    const records = [
      rec(1, 30, START_SEC + 10, { err: { InstructionError: [0, { Custom: 1 }] } }),
      rec(2, 20, START_SEC + 5, { err: "AccountInUse" }),
      rec(3, 10, START_SEC - 5),
    ];
    const p = analyze(records);
    expect(p).toMatchObject({
      counts: { failedTotal: 2, failedInsideOrBoundary: 2, insideInterval: 2 },
      observation: "INTERVAL_RECORDS_IN_PAGE",
      observationReasons: ["FAILED_TRANSACTION_METADATA"],
    });
    expect(p.records[0]).toMatchObject({
      failed: true,
      err: { InstructionError: [0, { Custom: 1 }] },
    });
    const h = harness({ fetch: { body: page(records) } });
    const r = await live(h);
    expect(r.verification).toMatchObject({
      pageObtained: true,
      observation: "INTERVAL_RECORDS_IN_PAGE",
    });
    expect(RETROSPECTIVE_LIMITATIONS.join(" ")).toContain("not evidence of an AMM v4 initialize2");
  });

  it("R-07: malformed responses, RPC errors and HTTP errors never yield a page", async () => {
    const malformed: [string, string | Buffer][] = [
      ["NOT_JSON", "nope"],
      ["NOT_AN_OBJECT", "[]"],
      ["NOT_JSON_RPC_2_0", JSON.stringify({ jsonrpc: "1.0", id: 1, result: [] })],
      ["RESPONSE_ID_MISMATCH", page([], 2)],
      ["RESPONSE_ID_MISMATCH", page([], "1")],
      ["RESPONSE_SHAPE_INVALID", JSON.stringify({ jsonrpc: "2.0", id: 1, result: [], extra: 1 })],
      ["RESULT_NOT_AN_ARRAY", JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })],
      [
        "TOO_MANY_RECORDS",
        page(Array.from({ length: 21 }, (_, i) => rec(i + 1, 1000 - i, END_SEC + 1))),
      ],
      ["RECORD_SHAPE_INVALID:0", page([{ ...rec(1, 10, START_SEC + 1), extra: true }])],
      ["RECORD_SHAPE_INVALID:0", page([withoutMemo(rec(1, 10, START_SEC + 1))])],
      ["SIGNATURE_INVALID:0", page([rec(1, 10, START_SEC + 1, { signature: "not-a-signature" })])],
      ["SLOT_INVALID:0", page([rec(1, -1, START_SEC + 1)])],
      ["SLOT_INVALID:0", page([rec(1, 1.5, START_SEC + 1)])],
      ["BLOCK_TIME_INVALID:0", page([rec(1, 10, -5)])],
      ["BLOCK_TIME_INVALID:0", page([{ ...rec(1, 10, null), blockTime: "1794829500" }])],
      [
        "CONFIRMATION_STATUS_INVALID:0",
        page([rec(1, 10, START_SEC + 1, { confirmationStatus: "processed" })]),
      ],
      [
        "CONFIRMATION_STATUS_INVALID:0",
        page([rec(1, 10, START_SEC + 1, { confirmationStatus: null as unknown as string })]),
      ],
      ["ERR_INVALID:0", page([rec(1, 10, START_SEC + 1, { err: [1] })])],
      ["MEMO_INVALID:0", page([rec(1, 10, START_SEC + 1, { memo: 5 as unknown as string })])],
      ["DUPLICATE_SIGNATURE:1", page([rec(1, 20, START_SEC + 1), rec(1, 10, START_SEC + 1)])],
      ["NOT_NEWEST_FIRST:1", page([rec(1, 10, START_SEC + 1), rec(2, 20, START_SEC + 2)])],
      ["ERROR_INVALID", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "x" } })],
      [
        "INVALID_UTF8",
        Buffer.concat([
          Buffer.from('{"jsonrpc":"2.0","id":1,"result":["'),
          Buffer.from([0xff]),
          Buffer.from('"]}'),
        ]),
      ],
    ];
    for (const [reason, body] of malformed) {
      expect(analyzeSignaturesResponse(Buffer.from(body), 1), reason).toEqual({
        kind: "MALFORMED",
        reason,
      });
    }
    const m = harness({ fetch: { body: "nope" } });
    const r = await live(m);
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: { outcome: "MALFORMED_RESPONSE", detail: "NOT_JSON" },
      verification: { integrity: { ok: true }, outcome: "MALFORMED_RESPONSE", pageObtained: false },
    });
    const rpc = harness({
      fetch: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
      },
    });
    const e = await live(rpc);
    expect(e).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: { outcome: "RPC_ERROR" },
      record: { rpcError: { code: -32601, message: "Method not found" }, page: null },
      verification: { integrity: { ok: true }, outcome: "RPC_ERROR" },
    });
    const http = harness({ fetch: { status: 503, body: "busy" } });
    expect((await live(http)).verification).toMatchObject({
      integrity: { ok: true },
      outcome: "HTTP_ERROR",
      pageObtained: false,
    });
    expect(http.calls).toHaveLength(1);
  });

  it("R-08: a response over 64 KiB is cut at the limit and never parsed", async () => {
    const big = page(
      Array.from({ length: 20 }, (_, i) =>
        rec(i + 1, 1000 - i, END_SEC + 1, { memo: "x".repeat(4000) }),
      ),
    );
    expect(Buffer.byteLength(big)).toBeGreaterThan(65_536);
    const h = harness({ fetch: { body: big } });
    const r = await live(h);
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: { outcome: "RESPONSE_LIMIT_EXCEEDED", analysis: null },
      verification: {
        integrity: { ok: true },
        outcome: "RESPONSE_LIMIT_EXCEEDED",
        pageObtained: false,
      },
    });
    expect(recordJson(h).response).toMatchObject({
      bodyState: "PARTIAL_OVERFLOW",
      originalBytes: 65_536,
      maxResponseBytes: 65_536,
    });
    expect(recordJson(h).page).toBeNull();
    // A declared oversize body is refused before reading.
    const declared = harness({ fetch: { body: "[]", headers: { "content-length": "70000" } } });
    expect((await live(declared)).acquisition?.outcome).toBe("RESPONSE_LIMIT_EXCEEDED");
  });

  it("R-09: the 10 s deadline ends a stalled request; nothing is retried", async () => {
    const h = harness({ fetch: { delayMs: 15_000 } });
    const r = await live(h);
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: {
        outcome: "DEADLINE_EXPIRED",
        startedAtMs: START_MS,
        deadlineAtMs: START_MS + 10_000,
      },
      verification: { integrity: { ok: true }, outcome: "DEADLINE_EXPIRED" },
    });
    expect(r.acquisition!.endedAtMs).toBeLessThanOrEqual(START_MS + 10_000);
    expect(h.calls).toHaveLength(1);
    expectSettled(h, r);
  });

  it("R-10: cancellation before dispatch, during the request and before sealing never yields a page", async () => {
    const before = harness();
    before.controller.abort();
    const b = await live(before);
    expect(b).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: { outcome: "OPERATOR_CANCELLED", exchange: null, cancelled: true },
      verification: { integrity: { ok: true }, outcome: "OPERATOR_CANCELLED", pageObtained: false },
    });
    expect(before.calls).toEqual([]);

    const during = harness({ fetch: { delayMs: 5_000 } });
    during.sched.at(START_MS + 1_000, () => during.controller.abort());
    const d = await live(during);
    expect(d).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: {
        outcome: "OPERATOR_CANCELLED",
        cancelled: true,
        cancellationPhase: "DURING_REQUEST",
      },
      verification: { integrity: { ok: true }, outcome: "OPERATOR_CANCELLED" },
    });
    expect(during.calls).toHaveLength(1);
    expectSettled(during, d);

    // After a valid page, from the log callback, before sealing: the page is kept, not obtained.
    const late = harness();
    const l = await live(late, {
      log: (line: string) => {
        late.lines.push(line);
        if (line.startsWith("[LIVE] Outcome:")) late.controller.abort();
      },
    });
    expect(l).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: {
        outcome: "PAGE_RECEIVED",
        cancelled: true,
        cancellationPhase: "BEFORE_SEALING",
      },
      record: { pageObtained: false, page: { observation: "INTERVAL_RECORDS_IN_PAGE" } },
      verification: { integrity: { ok: true }, outcome: "PAGE_RECEIVED", pageObtained: false },
    });
    expect((await late.run(["--verify", RUN])).exitCode).toBe(RETROSPECTIVE_EXIT_CODES.NO_PAGE);
  });

  it("R-11: credential-bearing errors and echoes are redacted; redirects and 429 stop the session", async () => {
    const thrown = harness({ fetch: { throwError: `connect failure to ${RPC_URL}` } });
    const t = await live(thrown);
    expect(t).toMatchObject({
      acquisition: { outcome: "TRANSPORT_ERROR" },
      verification: { integrity: { ok: true } },
    });
    expectNoSecrets(thrown);
    // A body echoing the key: stored redacted, so the page cannot be re-derived or reported as obtained.
    const echo = harness({
      fetch: { body: page([rec(1, 10, START_SEC + 1, { memo: `key ${RPC_KEY}` })]) },
    });
    const e = await live(echo);
    expect(e).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      verification: { integrity: { ok: true }, pageObtained: false },
    });
    expect(recordJson(echo).response).toMatchObject({ payloadRedacted: true });
    expectNoSecrets(echo);
    // Credential-bearing non-text bytes are redacted at byte level and stored as base64.
    const raw = Buffer.concat([
      Buffer.from(`{"x":"${RPC_KEY}`),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const bin = harness({ fetch: { body: raw } });
    const bb = await live(bin);
    expect(bb.acquisition?.outcome).toBe("MALFORMED_RESPONSE");
    expect(recordJson(bin).response).toMatchObject({
      storedEncoding: "base64",
      payloadRedacted: true,
      originalBytes: raw.length,
    });
    expectNoSecrets(bin);
    // Response headers are redacted text.
    const hdr = harness({ fetch: { headers: { "retry-after": RPC_KEY } } });
    await live(hdr);
    expectNoSecrets(hdr);
    for (const status of [302, 429]) {
      const s = harness({ fetch: { status, body: "", headers: { location: RPC_URL } } });
      const r = await live(s);
      expect(r.acquisition?.outcome, String(status)).toBe("SESSION_STOPPED");
      expect(s.calls, String(status)).toHaveLength(1);
      expect(r.verification?.integrity.ok).toBe(true);
      expectNoSecrets(s);
    }
  });

  it("R-12: a write failure is explicit and never repeats the request", async () => {
    const h = harness();
    let writes = 0;
    const r = await live(h, {
      writeFile: (file, content, options) => {
        writes++;
        if (file.endsWith(RETROSPECTIVE_FILES.retrospective))
          throw new Error(`SYNTHETIC disk full near ${RPC_KEY}`);
        writeFileSync(file, content, options);
      },
    });
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.SEAL_FAILED,
      seal: { ok: false, status: "ARTIFACT_WRITE_FAILED" },
    });
    expect(JSON.stringify(r.seal)).not.toContain(RPC_KEY);
    expect(writes).toBe(2);
    expect(h.calls).toHaveLength(1);
    expect(r.verification).toBeUndefined();
    const raced = harness();
    raced.sched.at(START_MS + 50, () => mkdirSync(raced.abs(RUN), { recursive: true }));
    const s = await live(raced);
    expect(s).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.SEAL_FAILED,
      seal: { ok: false, status: "OUTPUT_DIRECTORY_UNAVAILABLE" },
    });
    expect(raced.calls).toHaveLength(1);
  });

  it("R-13: offline verification fails closed on tampering, forged observations and malformed records", async () => {
    const h = harness();
    await live(h);
    const file = path.join(h.abs(RUN), RETROSPECTIVE_FILES.retrospective);
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original.replace("INTERVAL_RECORDS_IN_PAGE", "NO_INTERVAL_RECORDS_IN_PAGE"),
    );
    expect(verifyRetrospectiveEvidence(h.abs(RUN)).integrity.problems).toContain(
      `MODIFIED:${RETROSPECTIVE_FILES.retrospective}`,
    );
    writeFileSync(file, original);
    const forged: [string, (r: Loose) => void, string][] = [
      [
        "observation",
        (r) => void (r.page.observation = "NO_INTERVAL_RECORDS_IN_PAGE"),
        "PAGE_NOT_REPRODUCED",
      ],
      ["count", (r) => void (r.page.counts.insideInterval = 0), "PAGE_NOT_REPRODUCED"],
      [
        "record time",
        (r) => void (r.page.records[1].blockTime = START_SEC - 100),
        "PAGE_NOT_REPRODUCED",
      ],
      ["outcome", (r) => void (r.outcome = "RPC_ERROR"), "OUTCOME_NOT_REPRODUCED"],
      ["binding", (r) => void (r.binding.manifestSha256 = "0".repeat(64)), "BINDING_MISMATCH"],
      ["interval", (r) => void (r.binding.intervalEndMs += 1), "BINDING_MISMATCH"],
      ["binding check", (r) => void (r.bindingCheck.ok = false), "BINDING_CHECK_INVALID"],
      ["limitations", (r) => void r.limitations.pop(), "LIMITATIONS_MISMATCH"],
      ["limits", (r) => void (r.limits.pageLimit = 1000), "LIMITS_MISMATCH"],
      ["request params", (r) => void (r.request.rpcParams[1].limit = 1000), "REQUEST_INVALID"],
      [
        "stored digest",
        (r) => void (r.response.storedSha256 = "0".repeat(64)),
        "RESPONSE_ACCOUNTING_INVALID",
      ],
      ["payload", (r) => void (r.response.payload = page([])), "RESPONSE_ACCOUNTING_INVALID"],
      ["deadline", (r) => void (r.deadlineAtMs += 1), "TIMES_INVALID"],
      ["obtained", (r) => void (r.pageObtained = false), "PAGE_OBTAINED_MISMATCH"],
      [
        "cancellation",
        (r) => void (r.cancellationPhase = "BEFORE_SEALING"),
        "CANCELLATION_RECORD_INVALID",
      ],
    ];
    for (const [label, edit, problem] of forged) {
      const v = reforge(h, `forged-${label.replace(/ /g, "-")}`, edit);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain(problem);
      expect(v.pageObtained, label).toBe(false);
    }
    const malformed: [string, (r: Loose) => void][] = [
      ["page as a string", (r) => void (r.page = "x")],
      ["response as an array", (r) => void (r.response = [])],
      ["request missing", (r) => void delete r.request],
      ["times missing", (r) => void delete r.startedAtMs],
      ["records not an array", (r) => void (r.page.records = 1)],
    ];
    for (const [label, edit] of malformed) {
      let v: ReturnType<typeof verifyRetrospectiveEvidence> | undefined;
      expect(() => {
        v = reforge(h, `malformed-${label.replace(/ /g, "-")}`, edit);
      }, label).not.toThrow();
      expect(v!.integrity.ok, label).toBe(false);
    }
    writeFileSync(path.join(h.abs(RUN), "extra.json"), "{}");
    expect(verifyRetrospectiveEvidence(h.abs(RUN)).integrity.problems).toContain(
      "UNLISTED:extra.json",
    );
  });
});
