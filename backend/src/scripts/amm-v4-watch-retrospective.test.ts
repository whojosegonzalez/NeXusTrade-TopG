/**
 * Retrospective metadata check for watch 02 (offline). Every dependency is injected and SYNTHETIC:
 * a scripted fetch on the shared virtual scheduler and an injected watch binding. Artifacts are
 * written only into this test's own OS temporary directories. No real network, provider request,
 * credential or socket. One test reads the real sealed watch 02 evidence read-only when present.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  RETROSPECTIVE_REANALYSIS_LIMITATIONS,
  RETROSPECTIVE_RPC_PARAMS,
  RETROSPECTIVE_SHUTDOWN_FORCED_NOTICE,
  RETROSPECTIVE_SHUTDOWN_GRACE_MS,
  RETROSPECTIVE_USAGE,
  analyzeSignaturesResponse,
  bindWatchRun,
  printableRetrospectiveError,
  reanalyzeRetrospectiveCapture,
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
  transactionIndex?: unknown;
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

/** Rewrites one sealed file (with its manifest entry and summary) consistently, then verifies. */
function reforge(
  h: Harness,
  name: string,
  edit: (r: Loose) => void,
  target: string = RETROSPECTIVE_FILES.retrospective,
) {
  const dir = path.join(h.projectRoot, "data/research/retrospective-checks", name);
  cpSync(h.abs(RUN), dir, { recursive: true });
  const file = path.join(dir, target);
  const r = JSON.parse(readFileSync(file, "utf8")) as Loose;
  edit(r);
  const text = JSON.stringify(r, null, 2) + "\n";
  writeFileSync(file, text);
  const manifestPath = path.join(dir, RETROSPECTIVE_FILES.manifest);
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Loose;
  if (target === RETROSPECTIVE_FILES.retrospective && r && typeof r === "object") {
    m.outcome = r.outcome;
    m.pageObtained = r.pageObtained;
  }
  const entry = m.files.find((x: Loose) => x.path === target);
  entry.sha256 = createHash("sha256").update(text).digest("hex");
  entry.bytes = Buffer.byteLength(text);
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  return verifyRetrospectiveEvidence(dir);
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./amm-v4-watch-retrospective.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;
/** Child processes get no configuration or credentials: only what Windows needs to start Node. */
const CHILD_ENV = Object.fromEntries(
  ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k] as string]),
);
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const manifestDigest = (dir: string) =>
  sha(readFileSync(path.join(dir, RETROSPECTIVE_FILES.manifest)));
const dirDigest = (dir: string) =>
  sha(
    readdirSync(dir)
      .sort()
      .map((f) => `${f}:${sha(readFileSync(path.join(dir, f)))}`)
      .join("|"),
  );

/**
 * Copies the harness capture and rewrites it as the original strict (version 1) policy would have
 * sealed it: a page with fields outside the version 1 schema becomes MALFORMED_RESPONSE. Then an
 * optional edit; the record and manifest are re-hashed consistently.
 */
function asVersion1(
  h: Harness,
  name: string,
  edit?: (r: Loose) => void,
  manifestVersion: number = 1,
) {
  const dir = path.join(h.projectRoot, "data/research/retrospective-checks", name);
  cpSync(h.abs(RUN), dir, { recursive: true });
  const file = path.join(dir, RETROSPECTIVE_FILES.retrospective);
  const r = JSON.parse(readFileSync(file, "utf8")) as Loose;
  r.version = 1;
  if (r.outcome === "PAGE_RECEIVED") {
    const a = analyzeSignaturesResponse(
      Buffer.from(r.response.payload as string, "utf8"),
      r.request.jsonRpcId as number,
      1,
    );
    if (a.kind === "MALFORMED") {
      r.outcome = "MALFORMED_RESPONSE";
      r.detail = a.reason;
      r.page = null;
      r.pageObtained = false;
    } else if (a.kind === "PAGE") {
      r.page = a.page;
    }
  }
  edit?.(r);
  const text = `${JSON.stringify(r, null, 2)}\n`;
  writeFileSync(file, text);
  const manifestPath = path.join(dir, RETROSPECTIVE_FILES.manifest);
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Loose;
  m.version = manifestVersion;
  m.outcome = r.outcome;
  m.pageObtained = r.pageObtained;
  const entry = m.files.find((x: Loose) => x.path === RETROSPECTIVE_FILES.retrospective);
  entry.sha256 = sha(text);
  entry.bytes = Buffer.byteLength(text);
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  return dir;
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
    // Newer-side partial overlap: the oldest returned record is inside the interval.
    const partial = analyze([rec(1, 30, END_SEC + 5), rec(2, 20, START_SEC + 100)]);
    expect(partial).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_END",
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

  it("R-14: recorded acquisition timing: dispatch before the deadline, success within it", async () => {
    const h = harness();
    const ok = await live(h);
    expect(ok.verification).toMatchObject({ integrity: { ok: true }, pageObtained: true });
    const deadline = recordJson(h).deadlineAtMs as number;
    expect(deadline).toBe(START_MS + 10_000);
    // Late dispatch (at or after the absolute deadline), with consistent completion and end times.
    for (const delta of [0, 1, 5_000]) {
      const v = reforge(h, `late-dispatch-${delta}`, (r) => {
        r.request.dispatchedAtMs = deadline + delta;
        r.request.completedAtMs = deadline + delta + 100;
        r.endedAtMs = deadline + delta + 100;
      });
      expect(v.integrity.ok, `dispatch +${delta}`).toBe(false);
      expect(v.integrity.problems, `dispatch +${delta}`).toContain("DISPATCH_AFTER_DEADLINE");
      expect(v.pageObtained).toBe(false);
    }
    // Late successful completion still claiming a received page.
    for (const delta of [1, 5_000]) {
      const v = reforge(h, `late-complete-${delta}`, (r) => {
        r.request.completedAtMs = deadline + delta;
        r.endedAtMs = deadline + delta;
      });
      expect(v.integrity.ok, `complete +${delta}`).toBe(false);
      expect(v.integrity.problems, `complete +${delta}`).toContain("OUTCOME_NOT_REPRODUCED");
      expect(v.pageObtained).toBe(false);
    }
    // Completion exactly at the deadline is within it.
    expect(
      reforge(h, "complete-at-deadline", (r) => {
        r.request.completedAtMs = deadline;
        r.endedAtMs = deadline;
      }),
    ).toMatchObject({ integrity: { ok: true }, pageObtained: true });
    // Local post-acquisition processing overhead after the deadline is allowed.
    expect(reforge(h, "overhead", (r) => void (r.endedAtMs = deadline + 30_000))).toMatchObject({
      integrity: { ok: true },
      pageObtained: true,
    });
    // A genuinely late complete response (the acquisition clock started 5 ms before the session):
    // recorded as a deadline failure, the page kept but never obtained.
    let first = true;
    const skew = harness({ fetch: { delayMs: 9_998 } });
    const s = await live(skew, {
      clock: () => {
        if (first) {
          first = false;
          return skew.sched.now - 5;
        }
        return skew.sched.now;
      },
    });
    expect(s).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      acquisition: { outcome: "DEADLINE_EXPIRED", deadlineAtMs: START_MS + 9_995 },
      record: { pageObtained: false, page: { observation: "INTERVAL_RECORDS_IN_PAGE" } },
      verification: { integrity: { ok: true }, outcome: "DEADLINE_EXPIRED", pageObtained: false },
    });
    expect(recordJson(skew).request).toMatchObject({
      error: null,
      completedAtMs: START_MS + 9_998,
    });
    // Genuine failure captures keep their outcomes, including cleanup after the deadline.
    const stalled = harness({ fetch: { delayMs: 15_000 } });
    await live(stalled);
    const st = recordJson(stalled);
    expect(st.request.completedAtMs).toBeGreaterThanOrEqual(st.deadlineAtMs);
    expect(verifyRetrospectiveEvidence(stalled.abs(RUN))).toMatchObject({
      integrity: { ok: true },
      outcome: "DEADLINE_EXPIRED",
    });
    expect(
      reforge(stalled, "stalled-cleanup", (r) => {
        r.request.completedAtMs = r.deadlineAtMs + 400;
        r.endedAtMs = r.deadlineAtMs + 900;
      }),
    ).toMatchObject({ integrity: { ok: true }, outcome: "DEADLINE_EXPIRED", pageObtained: false });
    const cancelled = harness({ fetch: { delayMs: 5_000 } });
    cancelled.sched.at(START_MS + 1_000, () => cancelled.controller.abort());
    await live(cancelled);
    expect(verifyRetrospectiveEvidence(cancelled.abs(RUN))).toMatchObject({
      integrity: { ok: true },
      outcome: "OPERATOR_CANCELLED",
    });
    expect(
      reforge(cancelled, "cancelled-cleanup", (r) => {
        r.request.completedAtMs = r.deadlineAtMs + 400;
        r.endedAtMs = r.deadlineAtMs + 900;
      }),
    ).toMatchObject({ integrity: { ok: true }, outcome: "OPERATOR_CANCELLED" });
  });

  it("R-15: response accounting: body state and observed/original/stored bytes agree", async () => {
    const h = harness();
    await live(h);
    const small = recordJson(h).response.originalBytes as number;
    expect(small).toBeLessThan(65_536);
    // The reviewed reproduction.
    const over = reforge(h, "acct-observed-over", (r) => void (r.response.observedBytes = 65_537));
    expect(over.integrity.ok).toBe(false);
    expect(over.integrity.problems).toContain("RESPONSE_ACCOUNTING_INVALID");
    expect(over.pageObtained).toBe(false);
    const forged: [string, (r: Loose) => void][] = [
      ["observed above original", (r) => void (r.response.observedBytes = small + 1)],
      ["observed below original", (r) => void (r.response.observedBytes = small - 1)],
      ["observed missing", (r) => void (r.response.observedBytes = null)],
      ["unknown body state", (r) => void (r.response.bodyState = "MOSTLY_COMPLETE")],
      ["not read with a body", (r) => void (r.response.bodyState = "NOT_READ")],
      ["overflow below the limit", (r) => void (r.response.bodyState = "PARTIAL_OVERFLOW")],
      ["status missing with a body", (r) => void (r.response.httpStatus = null)],
    ];
    for (const [label, edit] of forged) {
      const v = reforge(h, `acct-${label.replace(/ /g, "-")}`, edit);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain("RESPONSE_ACCOUNTING_INVALID");
      expect(v.pageObtained, label).toBe(false);
    }
    // A genuine partial overflow: the retained prefix is exactly the limit; more was observed.
    const big = page(
      Array.from({ length: 20 }, (_, i) =>
        rec(i + 1, 1000 - i, END_SEC + 1, { memo: "x".repeat(4000) }),
      ),
    );
    const of = harness({ fetch: { body: big } });
    await live(of);
    expect(recordJson(of).response).toMatchObject({
      bodyState: "PARTIAL_OVERFLOW",
      originalBytes: 65_536,
    });
    expect(recordJson(of).response.observedBytes).toBeGreaterThan(65_536);
    expect(verifyRetrospectiveEvidence(of.abs(RUN))).toMatchObject({
      integrity: { ok: true },
      outcome: "RESPONSE_LIMIT_EXCEEDED",
    });
    const overflowForged: [string, (r: Loose) => void][] = [
      ["overflow observed at the limit", (r) => void (r.response.observedBytes = 65_536)],
      ["overflow without its error", (r) => void (r.request.error = "NETWORK_ERROR")],
      ["overflow marked complete", (r) => void (r.response.bodyState = "COMPLETE")],
    ];
    for (const [label, edit] of overflowForged) {
      const v = reforge(of, `acct-${label.replace(/ /g, "-")}`, edit);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain("RESPONSE_ACCOUNTING_INVALID");
    }
    // A genuine declared oversize: nothing read.
    const declared = harness({ fetch: { body: "[]", headers: { "content-length": "70000" } } });
    await live(declared);
    expect(recordJson(declared).response).toMatchObject({
      bodyState: "NOT_READ",
      observedBytes: null,
      originalBytes: null,
      payload: null,
    });
    expect(verifyRetrospectiveEvidence(declared.abs(RUN))).toMatchObject({
      integrity: { ok: true },
      outcome: "RESPONSE_LIMIT_EXCEEDED",
    });
    const notReadForged: [string, (r: Loose) => void][] = [
      ["not read with observed bytes", (r) => void (r.response.observedBytes = 0)],
      ["not read without an error", (r) => void (r.request.error = null)],
    ];
    for (const [label, edit] of notReadForged) {
      const v = reforge(declared, `acct-${label.replace(/ /g, "-")}`, edit);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain("RESPONSE_ACCOUNTING_INVALID");
    }
    // Genuine NOT_READ failures without a status (a transport error) still verify.
    const thrown = harness({ fetch: { throwError: "SYNTHETIC reset" } });
    await live(thrown);
    expect(recordJson(thrown).response).toMatchObject({ bodyState: "NOT_READ", httpStatus: null });
    expect(verifyRetrospectiveEvidence(thrown.abs(RUN))).toMatchObject({
      integrity: { ok: true },
      outcome: "TRANSPORT_ERROR",
    });
  });

  it("R-16: plan.json is validated against the fixed plan and the record", async () => {
    const h = harness();
    await live(h);
    const plan = JSON.parse(readFileSync(path.join(h.abs(RUN), RETROSPECTIVE_FILES.plan), "utf8"));
    expect(plan).toMatchObject({ mode: "LIVE", outDir: RUN });
    // The reviewed reproduction: more requests and a larger page in the plan.
    const both = reforge(
      h,
      "plan-limits-params",
      (p) => {
        p.limits.httpRequests = 50;
        p.request.rpcParams[1].limit = 1000;
      },
      RETROSPECTIVE_FILES.plan,
    );
    expect(both.integrity.ok).toBe(false);
    expect(both.integrity.problems).toContain("PLAN_INVALID");
    expect(both.pageObtained).toBe(false);
    const forged: [string, (p: Loose) => void][] = [
      ["http requests", (p) => void (p.limits.httpRequests = 50)],
      ["page limit param", (p) => void (p.request.rpcParams[1].limit = 1000)],
      ["commitment", (p) => void (p.request.rpcParams[1].commitment = "processed")],
      ["method", (p) => void (p.request.rpcMethod = "getTransaction")],
      ["address", (p) => void (p.binding.address = sig(9))],
      ["interval", (p) => void (p.binding.intervalStartMs -= 1)],
      ["limitations", (p) => void p.limitations.pop()],
      ["mode", (p) => void (p.mode = "DRY_RUN")],
      ["kind", (p) => void (p.kind = "SOMETHING_ELSE")],
      ["approval", (p) => void (p.approval = "APPROVED")],
      ["sequence", (p) => void p.sequence.push("Retry on failure")],
      ["endpoint", (p) => void (p.endpoint = "https://example.invalid")],
      ["extra field", (p) => void (p.fallback = true)],
      ["outDir outside the root", (p) => void (p.outDir = "data/research/prechecks/x")],
      ["outDir traversal", (p) => void (p.outDir = "data/research/retrospective-checks/..")],
      ["outDir missing", (p) => void delete p.outDir],
    ];
    for (const [label, edit] of forged) {
      const v = reforge(h, `plan-${label.replace(/ /g, "-")}`, edit, RETROSPECTIVE_FILES.plan);
      expect(v.integrity.ok, label).toBe(false);
      expect(v.integrity.problems, label).toContain("PLAN_INVALID");
      expect(v.pageObtained, label).toBe(false);
    }
    // A plan that is not an object fails closed.
    const arrDir = path.join(h.projectRoot, "data/research/retrospective-checks", "plan-array");
    cpSync(h.abs(RUN), arrDir, { recursive: true });
    const arrText = "[]\n";
    writeFileSync(path.join(arrDir, RETROSPECTIVE_FILES.plan), arrText);
    const mPath = path.join(arrDir, RETROSPECTIVE_FILES.manifest);
    const m = JSON.parse(readFileSync(mPath, "utf8")) as Loose;
    const entry = m.files.find((x: Loose) => x.path === RETROSPECTIVE_FILES.plan);
    entry.sha256 = createHash("sha256").update(arrText).digest("hex");
    entry.bytes = Buffer.byteLength(arrText);
    writeFileSync(mPath, JSON.stringify(m, null, 2) + "\n");
    expect(verifyRetrospectiveEvidence(arrDir).integrity.problems).toContain("PLAN_INVALID");
    // A valid offline copy under another name, or outside the evidence root, still verifies.
    const copy = path.join(h.projectRoot, "elsewhere", "copied-evidence");
    cpSync(h.abs(RUN), copy, { recursive: true });
    expect(verifyRetrospectiveEvidence(copy)).toMatchObject({
      integrity: { ok: true },
      pageObtained: true,
    });
  });

  it("R-17: a page spans the interval only when its known range brackets both boundaries", () => {
    // The reviewed reproduction: one record inside, one before, none after the interval.
    expect(analyze([rec(1, 30, START_SEC + 100), rec(2, 20, START_SEC - 100)])).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_START",
      observation: "INTERVAL_RECORDS_IN_PAGE",
    });
    // Newer side: past the end, but not back before the start.
    expect(analyze([rec(1, 30, END_SEC + 5), rec(2, 20, START_SEC + 100)])).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_END",
      observation: "INTERVAL_RECORDS_IN_PAGE",
    });
    // Entirely within the interval.
    expect(analyze([rec(1, 30, END_SEC - 5), rec(2, 20, START_SEC + 5)])).toMatchObject({
      coverage: "PAGE_WITHIN_INTERVAL",
      observation: "INTERVAL_RECORDS_IN_PAGE",
    });
    // Both boundaries bracketed.
    expect(analyze([rec(1, 30, END_SEC + 1), rec(2, 20, START_SEC - 1)]).coverage).toBe(
      "PAGE_SPANS_INTERVAL",
    );
    // A boundary second does not bracket its boundary: it stays ambiguous.
    expect(analyze([rec(1, 30, END_SEC), rec(2, 20, START_SEC - 50)])).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_START",
      observation: "BOUNDARY_RECORDS_ONLY",
      observationReasons: ["BOUNDARY_AMBIGUOUS"],
    });
    expect(analyze([rec(1, 30, END_SEC + 50), rec(2, 20, START_SEC)])).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_END",
      observation: "BOUNDARY_RECORDS_ONLY",
      observationReasons: ["BOUNDARY_AMBIGUOUS"],
    });
    // Null times keep the page inconclusive whatever the known range.
    expect(
      analyze([rec(1, 30, START_SEC + 100), rec(2, 20, null), rec(3, 10, START_SEC - 100)]),
    ).toMatchObject({
      coverage: "PAGE_OVERLAPS_INTERVAL_START",
      observationReasons: ["NULL_BLOCK_TIME"],
    });
    expect(
      analyze([rec(1, 30, END_SEC + 1), rec(2, 20, null), rec(3, 10, START_SEC - 1)]),
    ).toMatchObject({
      coverage: "PAGE_SPANS_INTERVAL",
      observation: "COVERAGE_INCONCLUSIVE",
      observationReasons: ["NULL_BLOCK_TIME"],
    });
  });

  it("R-18: record schema version 2 accepts an optional non-negative transactionIndex, nothing else", async () => {
    const one = (extra: Partial<Rec>, schema?: 1 | 2) =>
      analyzeSignaturesResponse(Buffer.from(page([rec(1, 10, START_SEC + 1, extra)])), 1, schema);
    // Absent: still valid; reported as null in a version 2 record.
    const absent = one({});
    expect(absent.kind).toBe("PAGE");
    if (absent.kind === "PAGE") expect(absent.page.records[0]?.transactionIndex).toBeNull();
    // Valid values.
    for (const v of [0, 1, 1095, Number.MAX_SAFE_INTEGER]) {
      const a = one({ transactionIndex: v });
      expect(a.kind, String(v)).toBe("PAGE");
      if (a.kind === "PAGE") expect(a.page.records[0]?.transactionIndex).toBe(v);
    }
    // Invalid values.
    for (const v of [-1, 1.5, "7", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(one({ transactionIndex: v }), JSON.stringify(v)).toEqual({
        kind: "MALFORMED",
        reason: "TRANSACTION_INDEX_INVALID:0",
      });
    }
    // Required fields and unrelated unknown fields are still enforced.
    expect(
      analyzeSignaturesResponse(
        Buffer.from(page([{ ...withoutMemo(rec(1, 10, START_SEC + 1)), transactionIndex: 3 }])),
        1,
      ),
    ).toEqual({ kind: "MALFORMED", reason: "RECORD_SHAPE_INVALID:0" });
    expect(one({ transactionIndex: 3, slotIndex: 3 } as Partial<Rec>)).toEqual({
      kind: "MALFORMED",
      reason: "RECORD_SHAPE_INVALID:0",
    });
    // Version 1 (the original strict policy) still rejects the field, and keeps its record shape.
    expect(one({ transactionIndex: 3 }, 1)).toEqual({
      kind: "MALFORMED",
      reason: "RECORD_SHAPE_INVALID:0",
    });
    const v1 = one({}, 1);
    if (v1.kind === "PAGE") expect("transactionIndex" in (v1.page.records[0] ?? {})).toBe(false);
    // A live capture with the field is sealed as version 2, verified and obtained.
    const records = SPANNING.map((r, i) => ({ ...r, transactionIndex: 10 + i }));
    const h = harness({ fetch: { body: page(records) } });
    const r = await live(h);
    expect(r).toMatchObject({
      exitCode: RETROSPECTIVE_EXIT_CODES.OK,
      acquisition: { outcome: "PAGE_RECEIVED" },
      verification: { integrity: { ok: true }, pageObtained: true, recordVersion: 2 },
    });
    expect(recordJson(h)).toMatchObject({
      version: 2,
      page: { records: [{ transactionIndex: 10 }, {}, {}, { transactionIndex: 13 }] },
    });
    const bad = harness({
      fetch: { body: page([rec(1, 10, START_SEC + 1, { transactionIndex: -1 })]) },
    });
    expect((await live(bad)).acquisition).toMatchObject({
      outcome: "MALFORMED_RESPONSE",
      detail: "TRANSACTION_INDEX_INVALID:0",
    });
  });

  it("R-19: a version 1 capture is replayed under the version 1 policy; versions cannot be swapped", async () => {
    const records = SPANNING.map((r, i) => ({ ...r, transactionIndex: 10 + i }));
    const h = harness({ fetch: { body: page(records) } });
    await live(h);
    // A capture sealed by the original strict policy: MALFORMED_RESPONSE, still intact.
    const v1 = asVersion1(h, "v1-capture");
    expect(verifyRetrospectiveEvidence(v1)).toMatchObject({
      integrity: { ok: true },
      outcome: "MALFORMED_RESPONSE",
      pageObtained: false,
      recordVersion: 1,
    });
    expect(
      JSON.parse(readFileSync(path.join(v1, RETROSPECTIVE_FILES.retrospective), "utf8")),
    ).toMatchObject({
      version: 1,
      outcome: "MALFORMED_RESPONSE",
      detail: "RECORD_SHAPE_INVALID:0",
    });
    // A version 1 record claiming the page fails replay under version 1.
    const claimed = asVersion1(h, "v1-claims-page", (r) => {
      r.outcome = "PAGE_RECEIVED";
      r.detail = null;
      r.pageObtained = true;
    });
    expect(verifyRetrospectiveEvidence(claimed)).toMatchObject({
      integrity: { ok: false, problems: expect.arrayContaining(["OUTCOME_NOT_REPRODUCED"]) },
      pageObtained: false,
    });
    // Relabelling the version 1 capture as version 2 (its outcome kept) fails replay under version 2.
    const relabelled = asVersion1(h, "v1-as-v2", (r) => void (r.version = 2), 2);
    expect(verifyRetrospectiveEvidence(relabelled).integrity.problems).toContain(
      "OUTCOME_NOT_REPRODUCED",
    );
    // Relabelling a version 2 page capture as version 1 fails replay under version 1.
    const down = reforge(h, "v2-as-v1", (r) => void (r.version = 1));
    expect(down.integrity.ok).toBe(false);
    // Record and manifest versions must agree, and must be supported.
    expect(
      verifyRetrospectiveEvidence(asVersion1(h, "v1-manifest-v2", undefined, 2)).integrity.problems,
    ).toContain("RECORD_KIND_INVALID");
    expect(
      verifyRetrospectiveEvidence(asVersion1(h, "v3", (r) => void (r.version = 3), 3)).integrity
        .problems,
    ).toContain("MANIFEST_INVALID");
  });

  it("R-20: offline reanalysis is separate, read-only and tied to the source manifest digest", async () => {
    const records = SPANNING.map((r, i) => ({ ...r, transactionIndex: 10 + i }));
    const h = harness({ fetch: { body: page(records) } });
    await live(h);
    const v1 = asVersion1(h, "v1-source");
    const digest = manifestDigest(v1);
    const before = dirDigest(v1);
    const re = reanalyzeRetrospectiveCapture(v1, digest);
    expect(re).toMatchObject({
      ok: true,
      sourceIntact: true,
      report: {
        kind: "PAPER_AMM_V4_WATCH_RETROSPECTIVE_REANALYSIS",
        source: {
          manifestSha256: digest,
          recordVersion: 1,
          acquisition: {
            outcome: "MALFORMED_RESPONSE",
            detail: "RECORD_SHAPE_INVALID:0",
            pageObtained: false,
          },
          verification: {
            integrity: "OK",
            recordSchemaVersion: 1,
            outcome: "MALFORMED_RESPONSE",
            pageObtained: false,
          },
        },
        interpretation: { recordSchemaVersion: 2, optionalRecordFields: ["transactionIndex"] },
        result: {
          kind: "PAGE",
          page: { coverage: "PAGE_SPANS_INTERVAL", observation: "INTERVAL_RECORDS_IN_PAGE" },
        },
        acquisitionOutcomeChanged: false,
        newAcquisitionPerformed: false,
      },
    });
    expect(re.report?.limitations).toEqual(RETROSPECTIVE_REANALYSIS_LIMITATIONS);
    // The source is untouched, and still verifies with its original outcome.
    expect(dirDigest(v1)).toBe(before);
    expect(verifyRetrospectiveEvidence(v1)).toMatchObject({ outcome: "MALFORMED_RESPONSE" });
    // Source problems.
    expect(reanalyzeRetrospectiveCapture(v1, "0".repeat(64))).toMatchObject({
      ok: false,
      sourceIntact: false,
      problems: ["SOURCE_MANIFEST_MISMATCH"],
    });
    expect(reanalyzeRetrospectiveCapture(v1, "XYZ").problems).toEqual([
      "SOURCE_MANIFEST_DIGEST_INVALID",
    ]);
    const tampered = asVersion1(h, "v1-tampered");
    writeFileSync(path.join(tampered, RETROSPECTIVE_FILES.plan), "{}\n");
    expect(reanalyzeRetrospectiveCapture(tampered, manifestDigest(tampered))).toMatchObject({
      ok: false,
      sourceIntact: false,
      problems: expect.arrayContaining(["SOURCE_INTEGRITY_FAILED"]),
    });
    expect(reanalyzeRetrospectiveCapture(h.abs(RUN), manifestDigest(h.abs(RUN)))).toMatchObject({
      ok: false,
      sourceIntact: true,
      problems: ["SOURCE_ALREADY_CURRENT_VERSION"],
    });
    const http = harness({ fetch: { status: 503, body: "busy" } });
    await live(http);
    const ineligible = asVersion1(http, "v1-http-503");
    expect(verifyRetrospectiveEvidence(ineligible).outcome).toBe("HTTP_ERROR");
    expect(reanalyzeRetrospectiveCapture(ineligible, manifestDigest(ineligible))).toMatchObject({
      ok: false,
      sourceIntact: true,
      problems: ["SOURCE_RESPONSE_NOT_ELIGIBLE"],
    });
    // The CLI path: read-only, exit codes kept apart from acquisition.
    const rel = "data/research/retrospective-checks/v1-source";
    const ok = await h.run(["--reanalyze", rel, "--source-manifest", digest]);
    expect(ok).toMatchObject({ mode: "REANALYZE", exitCode: RETROSPECTIVE_EXIT_CODES.OK });
    expect(h.lines.some((l) => l.includes("sealed outcome MALFORMED_RESPONSE (unchanged)"))).toBe(
      true,
    );
    expect((await h.run(["--reanalyze", rel, "--source-manifest", "0".repeat(64)])).exitCode).toBe(
      RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED,
    );
    expect(
      (
        await h.run([
          "--reanalyze",
          "data/research/retrospective-checks/retro-01",
          "--source-manifest",
          manifestDigest(h.abs(RUN)),
        ])
      ).exitCode,
    ).toBe(RETROSPECTIVE_EXIT_CODES.NO_PAGE);
    for (const args of [
      ["--reanalyze", rel],
      ["--reanalyze", rel, "--source-manifest", "ABC"],
      ["--source-manifest", digest],
      ["--reanalyze", rel, "--source-manifest", digest, "--live"],
      ["--reanalyze", rel, "--source-manifest", digest, "--verify", rel],
      ["--reanalyze", "elsewhere/v1-source", "--source-manifest", digest],
    ]) {
      await expect(h.run(args), args.join(" ")).rejects.toThrow("[CLI_INVALID_ARG]");
    }
    expect(h.calls).toHaveLength(1);
    expect(h.loads()).toBe(1);
    expect(dirDigest(v1)).toBe(before);

    // Synthetic regression: an intact version-1 PAGE_RECEIVED capture without transactionIndex.
    // Reanalysis preserves the original successful acquisition (pageObtained: true) while
    // explicitly reporting that no new acquisition occurred (newAcquisitionPerformed: false).
    const hPage = harness({ fetch: { body: page(SPANNING) } });
    await live(hPage);
    const v1Page = asVersion1(hPage, "v1-page-success");
    const v1PageDigest = manifestDigest(v1Page);
    const v1PageBefore = dirDigest(v1Page);
    expect(verifyRetrospectiveEvidence(v1Page)).toMatchObject({
      integrity: { ok: true, problems: [] },
      outcome: "PAGE_RECEIVED",
      pageObtained: true,
      recordVersion: 1,
    });
    const rePage = reanalyzeRetrospectiveCapture(v1Page, v1PageDigest);
    expect(rePage).toMatchObject({
      ok: true,
      sourceIntact: true,
      report: {
        kind: "PAPER_AMM_V4_WATCH_RETROSPECTIVE_REANALYSIS",
        source: {
          manifestSha256: v1PageDigest,
          recordVersion: 1,
          acquisition: {
            outcome: "PAGE_RECEIVED",
            pageObtained: true,
          },
          verification: {
            integrity: "OK",
            recordSchemaVersion: 1,
            outcome: "PAGE_RECEIVED",
            pageObtained: true,
          },
        },
        interpretation: { recordSchemaVersion: 2, optionalRecordFields: ["transactionIndex"] },
        result: {
          kind: "PAGE",
          page: { coverage: "PAGE_SPANS_INTERVAL", observation: "INTERVAL_RECORDS_IN_PAGE" },
        },
        acquisitionOutcomeChanged: false,
        newAcquisitionPerformed: false,
      },
    });
    expect(rePage.report?.limitations).toEqual(RETROSPECTIVE_REANALYSIS_LIMITATIONS);
    expect(dirDigest(v1Page)).toBe(v1PageBefore);
    const relPage = "data/research/retrospective-checks/v1-page-success";
    const okPage = await hPage.run(["--reanalyze", relPage, "--source-manifest", v1PageDigest]);
    expect(okPage).toMatchObject({ mode: "REANALYZE", exitCode: RETROSPECTIVE_EXIT_CODES.OK });
    expect(hPage.lines.some((l) => l.includes("sealed outcome PAGE_RECEIVED (unchanged)"))).toBe(
      true,
    );
  });

  const REAL_CAPTURE = path.join(
    REPO_ROOT,
    "data",
    "research",
    "retrospective-checks",
    "amm-v4-watch-02-01",
  );
  const REAL_CAPTURE_MANIFEST = "71f05220233c973d2bdbd95b6e7d3e40b0712266ccd713097b76e452cfeabeeb";
  it.skipIf(!existsSync(REAL_CAPTURE))(
    "R-20b: the sealed capture amm-v4-watch-02-01 keeps its outcome; its reanalysis is independently checked (read-only)",
    () => {
      const before = dirDigest(REAL_CAPTURE);
      expect(verifyRetrospectiveEvidence(REAL_CAPTURE)).toEqual({
        integrity: { ok: true, problems: [] },
        outcome: "MALFORMED_RESPONSE",
        pageObtained: false,
        observation: null,
        manifestSha256: REAL_CAPTURE_MANIFEST,
        recordVersion: 1,
      });
      const re = reanalyzeRetrospectiveCapture(REAL_CAPTURE, REAL_CAPTURE_MANIFEST);
      expect(re).toMatchObject({
        ok: true,
        report: {
          source: {
            manifestSha256: REAL_CAPTURE_MANIFEST,
            recordVersion: 1,
            responseBytes: 4675,
            acquisition: { outcome: "MALFORMED_RESPONSE", detail: "RECORD_SHAPE_INVALID:0" },
          },
          result: {
            kind: "PAGE",
            page: {
              coverage: "PAGE_OLDER_THAN_INTERVAL",
              observation: "NO_INTERVAL_RECORDS_IN_PAGE",
              observationReasons: [],
              fullPage: true,
              newestKnownBlockTime: 1_794_551_672,
              oldestKnownBlockTime: 1_792_474_081,
              counts: {
                returned: 20,
                beforeInterval: 20,
                boundaryStart: 0,
                insideInterval: 0,
                boundaryEnd: 0,
                afterInterval: 0,
                unknownTime: 0,
                failedTotal: 2,
                failedInsideOrBoundary: 0,
              },
            },
          },
          acquisitionOutcomeChanged: false,
        },
      });
      // Independent projection straight from the sealed JSON (not through the analyser).
      const sealed = JSON.parse(
        readFileSync(path.join(REAL_CAPTURE, RETROSPECTIVE_FILES.retrospective), "utf8"),
      ) as Loose;
      const body = JSON.parse(sealed.response.payload as string) as Loose;
      expect(
        createHash("sha256")
          .update(sealed.response.payload as string)
          .digest("hex"),
      ).toBe(sealed.response.originalSha256);
      const rows = body.result as Loose[];
      expect(rows).toHaveLength(20);
      const times = rows.map((x) => x.blockTime as number);
      expect(Math.max(...times)).toBe(1_794_551_672);
      expect(Math.min(...times)).toBe(1_792_474_081);
      expect(times.every((t) => Number.isInteger(t) && t < START_SEC)).toBe(true);
      expect(rows.filter((x) => x.err !== null)).toHaveLength(2);
      for (const x of rows) {
        expect(Object.keys(x).sort()).toEqual([
          "blockTime",
          "confirmationStatus",
          "err",
          "memo",
          "signature",
          "slot",
          "transactionIndex",
        ]);
        expect(Number.isSafeInteger(x.transactionIndex) && x.transactionIndex >= 0).toBe(true);
      }
      expect(dirDigest(REAL_CAPTURE)).toBe(before);
    },
  );

  it("R-21: the CLI shuts down gracefully in a child process with its exit codes kept (synthetic root)", async () => {
    const records = SPANNING.map((r, i) => ({ ...r, transactionIndex: 10 + i }));
    const h = harness({ fetch: { body: page(records) } });
    await live(h);
    const v1 = asVersion1(h, "v1-child");
    mkdirSync(path.join(h.projectRoot, ".git"));
    const child = (args: readonly string[]) => {
      const r = spawnSync(process.execPath, ["--import", TSX_LOADER, SCRIPT, ...args], {
        cwd: h.projectRoot,
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: CHILD_ENV,
      });
      expect(r.error, args.join(" ")).toBeUndefined();
      expect(r.signal, args.join(" ")).toBeNull();
      expect(r.stderr, args.join(" ")).not.toContain(RETROSPECTIVE_SHUTDOWN_FORCED_NOTICE);
      return r;
    };
    const root = "data/research/retrospective-checks";
    expect(child(["--help"]).status).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    const bad = child(["--bogus"]);
    expect(bad.status).toBe(RETROSPECTIVE_EXIT_CODES.INVALID);
    expect(bad.stderr).toContain("[AMM_V4_WATCH_RETROSPECTIVE_ERROR]");
    expect(child(["--out-dir", `${root}/child-dry-run`]).status).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    expect(existsSync(h.abs(`${root}/child-dry-run`))).toBe(false);
    expect(child(["--verify", `${root}/missing`]).status).toBe(
      RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED,
    );
    expect(child(["--verify", RUN]).status).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    expect(child(["--verify", `${root}/v1-child`]).status).toBe(RETROSPECTIVE_EXIT_CODES.NO_PAGE);
    const re = child(["--reanalyze", `${root}/v1-child`, "--source-manifest", manifestDigest(v1)]);
    expect(re.status).toBe(RETROSPECTIVE_EXIT_CODES.OK);
    expect(re.stdout).toContain("sealed outcome MALFORMED_RESPONSE (unchanged)");
    expect(
      child(["--reanalyze", `${root}/v1-child`, "--source-manifest", "0".repeat(64)]).status,
    ).toBe(RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED);
  }, 55_000);

  it("R-22: graceful settlement drains naturally; a lingering handle is force-exited after the bound", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "retrospective-settle-"));
    roots.push(dir);
    const driver = path.join(dir, "settle-driver.mts");
    writeFileSync(
      driver,
      [
        `import { settleRetrospectiveProcess } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
        `const [code, grace, linger] = process.argv.slice(2).map(Number);`,
        `if (linger) setInterval(() => undefined, 1_000);`,
        `settleRetrospectiveProcess(code, grace);`,
        `console.log("SETTLED");`,
      ].join("\n"),
    );
    const run = (args: string[]) => {
      const started = Date.now();
      const r = spawnSync(process.execPath, ["--import", TSX_LOADER, driver, ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: CHILD_ENV,
      });
      return { ...r, elapsedMs: Date.now() - started };
    };
    // Nothing pending: the process ends on its own with the code, without the backstop.
    const natural = run(["3", "15000", "0"]);
    expect(natural.error).toBeUndefined();
    expect(natural.status).toBe(3);
    expect(natural.stdout).toContain("SETTLED");
    expect(natural.stderr).not.toContain(RETROSPECTIVE_SHUTDOWN_FORCED_NOTICE);
    expect(natural.elapsedMs).toBeLessThan(15_000);
    // A lingering referenced handle: forced after the (short, synthetic) bound with the same code.
    const forced = run(["4", "300", "1"]);
    expect(forced.error).toBeUndefined();
    expect(forced.status).toBe(4);
    expect(forced.stderr).toContain(RETROSPECTIVE_SHUTDOWN_FORCED_NOTICE);
    expect(RETROSPECTIVE_SHUTDOWN_GRACE_MS).toBe(5_000);
    // The entry point no longer exits immediately.
    const source = readFileSync(SCRIPT, "utf8");
    const entry = source.slice(source.lastIndexOf("if (process.argv[1]"));
    expect(entry).not.toContain("process.exit(");
    expect(entry.match(/settleRetrospectiveProcess\(/g)).toHaveLength(2);
  }, 55_000);
});
