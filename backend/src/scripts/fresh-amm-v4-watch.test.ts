/**
 * Watch entry point (offline): collector → validator → sealer composed by `runFreshAmmV4Watch`.
 * Every dependency is injected and SYNTHETIC: a scripted in-memory WebSocket transport, a mocked
 * fetch and the shared virtual scheduler. Artifacts are written only into this test's own OS
 * temporary directories. No real network, socket, daemon, credential or capture.
 */
import os from "node:os";
import path from "node:path";
import {
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
  WATCH_EXIT_CODES,
  WATCH_RUN_POLICY,
  WATCH_USAGE,
  printableError,
  runFreshAmmV4Watch,
  type FreshAmmV4WatchDeps,
  type FreshAmmV4WatchResult,
  type WatchRunStageBoundary,
} from "./fresh-amm-v4-watch.js";
import { WATCH_EVIDENCE_FILES, verifyWatchEvidence } from "./fresh-amm-v4-watch-evidence.js";
import {
  SOLANA_ENDPOINT_ERRORS,
  resolveSolanaEndpoints,
} from "./paper-single-candidate-diagnostic.js";
import {
  ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER,
  REVIEWED_TREE_MODIFICATIONS,
  evaluateWatchedPilotHandoff,
  type GitRunner,
} from "./paper-pilot-handoff.js";
import { DEFAULT_CREATION_WATCH_LIMITS } from "../candidate-scanner/BoundedAmmV4CreationWatch.js";
import {
  DEFAULT_WATCH_VALIDATION_LIMITS,
  OVERALL_SESSION_DEADLINE_MS,
} from "../candidate-scanner/AmmV4WatchCandidateValidation.js";
import type { ISolanaKeepaliveWebSocketTransport } from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import {
  PRECHECK_ROOT_SEGMENTS,
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
} from "./fresh-amm-v4-precheck.js";
import {
  MINT,
  POOL,
  START_MS,
  TEST_RPC_URL,
  VirtualScheduler,
  drive,
  initTransactionResult,
  marketResponse,
} from "./fresh-amm-v4-precheck.test-support.js";

type Loose = ReturnType<typeof JSON.parse>;

const SIG =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const RPC_KEY = "SYNTHETIC-watch-entry-key-987";
const RPC_URL = `${TEST_RPC_URL}/?key=${RPC_KEY}`;
const WS_URL = RPC_URL.replace(/^http:/i, "ws:");
const SECRETS = [RPC_URL, WS_URL, RPC_KEY];
const NOTIFY_AT = START_MS + 10_000;
const RUN = [...PRECHECK_ROOT_SEGMENTS, "watch-run-01"].join("/");

// ---------------------------------------------------------------------------------------------
// SYNTHETIC harness
// ---------------------------------------------------------------------------------------------

class ScriptedTransport implements ISolanaKeepaliveWebSocketTransport {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((...args: never[]) => void)[]> = {};
  constructor(private readonly o: { throwOnClose?: boolean; stayOpen?: boolean } = {}) {}
  on = ((event: string, listener: (...args: never[]) => void) => {
    (this.listeners[event] ??= []).push(listener);
  }) as ISolanaKeepaliveWebSocketTransport["on"];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.o.throwOnClose) throw new Error("SYNTHETIC close failure");
    this.readyState = 3;
  }
  terminate(): void {
    if (!this.o.stayOpen) this.readyState = 3;
  }
  ping(data?: Buffer): void {
    for (const l of this.listeners.pong ?? []) (l as (d: Buffer) => void)(data ?? Buffer.alloc(0));
  }
  open(): void {
    this.readyState = 1;
    for (const l of this.listeners.open ?? []) (l as () => void)();
  }
  message(data: string | Buffer): void {
    for (const l of this.listeners.message ?? []) (l as (d: string | Buffer) => void)(data);
  }
  listenerCount(): number {
    return Object.values(this.listeners).reduce((n, ls) => n + ls.length, 0);
  }
}

const ACK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 });
const NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "logsNotification",
  params: {
    subscription: 42,
    result: {
      context: { slot: 250_000 },
      value: { err: null, signature: SIG, logs: ["Program log: initialize2"] },
    },
  },
});

interface FetchOptions {
  rpcStatus?: number;
  rpcDelayMs?: number;
  marketDelayMs?: number;
  marketThrows?: boolean;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function harness(
  o: {
    script?: readonly { atMs: number; data: string }[];
    transport?: { throwOnClose?: boolean; stayOpen?: boolean };
    fetch?: FetchOptions;
    env?: Record<string, string | undefined>;
    expectWsUrl?: string;
  } = {},
) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "watch-entry-test-"));
  roots.push(projectRoot);
  const sched = new VirtualScheduler(START_MS);
  const lines: string[] = [];
  const transports: ScriptedTransport[] = [];
  const calls: { url: string; body: string | null }[] = [];
  let loads = 0;
  const controller = new AbortController();
  const script = o.script ?? [
    { atMs: 600, data: ACK },
    { atMs: 10_000, data: NOTIFICATION },
  ];
  for (const s of script) {
    sched.at(START_MS + s.atMs, () => {
      const t = transports[0];
      if (t && t.readyState === 1) t.message(s.data);
    });
  }
  const delay = (ms: number, signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const id = sched.add(() => resolve(), ms, "harness");
      signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  const f = o.fetch ?? {};
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body });
    if (url.startsWith(TEST_RPC_URL)) {
      await delay(f.rpcDelayMs ?? 100, init?.signal);
      if (f.rpcStatus !== undefined && f.rpcStatus !== 200) {
        return new Response(JSON.stringify({ error: "SYNTHETIC" }), { status: f.rpcStatus });
      }
      const id = (JSON.parse(String(body)) as { id: number }).id;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: initTransactionResult({
            signature: SIG,
            slot: 250_000,
            blockTime: Math.floor(START_MS / 1000) - 300,
            openTime: Math.floor(START_MS / 1000) - 290,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.dexscreener.com/")) {
      await delay(f.marketDelayMs ?? 100, init?.signal);
      if (f.marketThrows) throw new Error("SYNTHETIC network failure");
      return new Response(JSON.stringify(marketResponse(START_MS - 300_000)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`SYNTHETIC: unexpected URL ${url}`);
  }) as unknown as typeof fetch;

  const deps = (extra: Partial<FreshAmmV4WatchDeps> = {}): FreshAmmV4WatchDeps => ({
    env: o.env ?? { SOLANA_RPC_URL: RPC_URL },
    loadEnvironment: () => {
      loads++;
    },
    createWebSocketTransport: (url: string) => {
      expect(url).toBe(o.expectWsUrl ?? WS_URL);
      const t = new ScriptedTransport(o.transport);
      transports.push(t);
      sched.add(() => t.open(), 0, "harness");
      return t;
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
    ...extra,
  });
  const run = (args: readonly string[], extra: Partial<FreshAmmV4WatchDeps> = {}) =>
    drive(sched, runFreshAmmV4Watch(args, deps(extra)));
  return {
    projectRoot,
    sched,
    lines,
    transports,
    calls,
    controller,
    loads: () => loads,
    run,
    abs: (rel: string) => path.join(projectRoot, ...rel.split("/")),
  };
}

type Harness = ReturnType<typeof harness>;

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => {
    const p = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? listFiles(dir, p) : [p];
  });
}

/** No credential form in any printed line or in any stored file. */
function expectNoSecrets(h: Harness) {
  for (const line of h.lines) for (const s of SECRETS) expect(line.includes(s), line).toBe(false);
  if (!existsSync(h.abs(RUN))) return;
  for (const f of listFiles(h.abs(RUN))) {
    const text = readFileSync(path.join(h.abs(RUN), ...f.split("/")), "utf8");
    for (const s of SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
  }
}

/** Owned timers and transports are gone when the run returns. */
function expectCleanedUp(h: Harness, r: FreshAmmV4WatchResult) {
  expect(h.sched.count("provider")).toBe(0);
  for (const t of h.transports) expect(t.readyState).toBe(3);
  expect(r.cleanup?.transportsStillOpen).toBe(0);
}

const readJson = (h: Harness, rel: string): Loose =>
  JSON.parse(readFileSync(path.join(h.abs(RUN), ...rel.split("/")), "utf8"));

/** A fake git runner for which the code pin passes (handoff assertions only). */
const allowedGit: GitRunner = (args) => {
  if (args[0] === "diff" && args[1] === "--name-status") {
    return {
      status: 0,
      stdout: [
        ...ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER.map((f) => `A\t${f}`),
        ...Object.keys(REVIEWED_TREE_MODIFICATIONS).map((f) => `M\t${f}`),
      ].join("\n"),
    };
  }
  if (args[0] === "ls-tree") {
    return {
      status: 0,
      stdout: Object.entries(REVIEWED_TREE_MODIFICATIONS)
        .map(([file, e]) => `${e.mode} ${e.type} ${e.oid}\t${file}`)
        .join("\n"),
    };
  }
  return { status: 0, stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" };
};

const rpcMethods = (h: Harness) =>
  h.calls
    .filter((c) => c.url.startsWith(TEST_RPC_URL))
    .map((c) => (JSON.parse(String(c.body)) as { method: string }).method);

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("fresh AMM v4 watch entry point (offline)", () => {
  it("E-01: help, dry run and verify are inert; conflicting modes are refused", async () => {
    const h = harness();
    const help = await h.run(["--help"]);
    expect(help).toMatchObject({ mode: "HELP", exitCode: WATCH_EXIT_CODES.OK });
    expect(h.lines[0]).toBe(WATCH_USAGE);
    expect(h.lines.join("\n")).toContain("PAPER_FRESH_AMM_V4_WATCH_RUN_PLAN");

    const dry = await h.run(["--out-dir", RUN]);
    expect(dry).toMatchObject({ mode: "DRY_RUN", exitCode: 0 });
    expect(dry.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    const plan = JSON.parse(h.lines[h.lines.length - 1]!) as Loose;
    expect(plan).toMatchObject({ mode: "DRY_RUN", outDir: RUN });
    // The plan states the reviewed, fixed limits.
    expect(plan.policy.webSocket).toMatchObject({
      connections: 1,
      subscriptions: 1,
      reconnects: 0,
      retries: 0,
      maxQualifyingNotifications: 1,
      feeDestination: RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
      limits: { ...DEFAULT_CREATION_WATCH_LIMITS },
    });
    expect(plan.policy.validation).toMatchObject({
      transactionRetrievals: 1,
      marketRequests: 1,
      signaturePages: 0,
      limits: { ...DEFAULT_WATCH_VALIDATION_LIMITS },
      overallSessionDeadlineMs: 930_000,
    });
    expect(WATCH_RUN_POLICY.webSocket.limits.watchCeilingMs).toBe(900_000);
    expect(WATCH_RUN_POLICY.validation.limits).toMatchObject({
      maxHttpAttempts: 2,
      requestTimeoutMs: 10_000,
      rpcMaxResponseBytes: 1_048_576,
      dexscreenerMaxResponseBytes: 1_048_576,
      validationWindowMs: 30_000,
    });
    expect(OVERALL_SESSION_DEADLINE_MS).toBe(930_000);

    // Verify on a missing run reads nothing else and reports an integrity failure.
    const verify = await h.run(["--verify", RUN]);
    expect(verify).toMatchObject({
      mode: "VERIFY",
      exitCode: WATCH_EXIT_CODES.INTEGRITY_FAILED,
      verification: { integrity: { ok: false, problems: ["OUTPUT_DIRECTORY_MISSING"] } },
    });

    // Nothing was loaded, opened, requested or written.
    expect(h.loads()).toBe(0);
    expect(h.transports).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(readdirSync(h.projectRoot)).toEqual([]);
    expectNoSecrets(h);

    for (const args of [
      ["--help", "--live"],
      ["--help", "--out-dir", RUN],
      ["--verify", RUN, "--live"],
      ["--verify", RUN, "--out-dir", RUN],
      ["--live"],
      [],
      ["--out-dir", RUN, "--out-dir", RUN],
      ["--out-dir", RUN, "positional"],
      ["--out-dir", RUN, "--reconnect"],
      ["--verify", ""],
    ]) {
      await expect(h.run(args), args.join(" ")).rejects.toThrow(/^\[CLI_INVALID_ARG\]/);
    }
    expect(h.loads()).toBe(0);
    expect(h.transports).toEqual([]);
  });

  it("E-02: invalid output locations and configuration are refused before any transport or write", async () => {
    const h = harness();
    for (const out of [
      "data/research/single-candidate/watch",
      PRECHECK_ROOT_SEGMENTS.join("/"),
      `${RUN}/nested`,
      [...PRECHECK_ROOT_SEGMENTS, "bad name"].join("/"),
      [...PRECHECK_ROOT_SEGMENTS, ".hidden"].join("/"),
      "../outside",
    ]) {
      await expect(h.run(["--out-dir", out, "--live"]), out).rejects.toThrow(
        /^\[CLI_INVALID_ARG\]/,
      );
    }
    mkdirSync(h.abs(RUN), { recursive: true });
    await expect(h.run(["--out-dir", RUN, "--live"])).rejects.toThrow(/^\[OUTPUT_EXISTS\]/);
    await expect(h.run(["--out-dir", RUN])).rejects.toThrow(/^\[OUTPUT_EXISTS\]/);
    expect(h.loads()).toBe(0);
    rmSync(h.abs(RUN), { recursive: true });

    for (const env of [
      {},
      { SOLANA_RPC_URL: "" },
      { SOLANA_RPC_URL: "wss://synthetic.invalid/?key=SYNTHETIC-not-http" },
      { SOLANA_RPC_URL: "ftp://synthetic.invalid" },
      { SOLANA_RPC_URL: "http://" },
    ]) {
      const c = harness({ env });
      const err = await c.run(["--out-dir", RUN, "--live"]).catch((e: unknown) => e);
      expect(err, JSON.stringify(env)).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        "[MISSING_CONFIGURATION] SOLANA_RPC_URL (http or https) is required for --live",
      );
      expect(printableError(err)).toBe((err as Error).message);
      expect(c.loads()).toBe(1);
      expect(c.transports).toEqual([]);
      expect(c.calls).toEqual([]);
      expect(readdirSync(c.projectRoot)).toEqual([]);
    }
    // Errors from elsewhere print only their code.
    expect(printableError(new Error(`[TRANSPORT_X] ${RPC_URL}`))).toBe("[TRANSPORT_X]");
    expect(printableError(new Error(`free text ${RPC_KEY}`))).toBe("[UNEXPECTED_ERROR]");
  });

  it("E-03: a captured notification is validated, sealed and verified as a confirmed selection", async () => {
    const h = harness();
    const stages: WatchRunStageBoundary[] = [];
    const r = await h.run(["--out-dir", RUN, "--live"], { onStage: (s) => stages.push(s) });
    expect(r).toMatchObject({
      mode: "LIVE",
      exitCode: WATCH_EXIT_CODES.OK,
      outDir: RUN,
      watchStatus: "NOTIFICATION_CAPTURED",
      validationOutcome: "TARGET_SELECTED",
      terminalCause: { code: "COMPLETED", stage: "VALIDATION", detail: null },
      cancellationAfterValidation: false,
      seal: { ok: true, status: "SEALED" },
      verification: {
        integrity: { ok: true, problems: [] },
        completeness: { sufficientForSelection: true, reasons: [] },
        rederivation: "REPRODUCED",
        selectionConfirmed: true,
        confirmedTarget: { poolId: POOL, mintAddress: MINT },
      },
      cleanup: { transportsOpened: 1, transportsForceClosed: 0, transportsStillOpen: 0 },
    });
    expect(stages).toEqual(["BEFORE_WATCH", "AFTER_WATCH", "AFTER_VALIDATION", "BEFORE_SEAL"]);
    expect(h.loads()).toBe(1);

    // One connection, one subscription on the pinned fee destination; no signature page.
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]!.sent).toHaveLength(1);
    expect(JSON.parse(h.transports[0]!.sent[0]!)).toMatchObject({
      method: "logsSubscribe",
      params: [
        { mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] },
        { commitment: "confirmed" },
      ],
    });
    expect(rpcMethods(h)).toEqual(["getTransaction"]);
    expect(h.calls.map((c) => c.url)).toEqual([
      RPC_URL,
      `https://api.dexscreener.com/latest/dex/tokens/${MINT}`,
    ]);

    // The sealed run is exactly what the reviewed verifier confirms, and holds no credential.
    const v = verifyWatchEvidence(h.abs(RUN));
    expect(v.selectionConfirmed).toBe(true);
    expect(readJson(h, WATCH_EVIDENCE_FILES.plan)).toMatchObject({
      kind: "PAPER_FRESH_AMM_V4_WATCH_RUN_PLAN",
      mode: "LIVE",
    });
    const validation = readJson(h, WATCH_EVIDENCE_FILES.validation);
    expect(validation.result.validationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);
    expectNoSecrets(h);
    expectCleanedUp(h, r);
    expect(h.lines.join("\n")).toContain("no Stage B launch");
    expect(h.lines.some((l) => l.includes("Selection: CONFIRMED"))).toBe(true);
  });

  it("E-04: no qualifying notification ends at the 900 s ceiling, seals without validation and is not confirmed", async () => {
    const h = harness({ script: [{ atMs: 600, data: ACK }] });
    const r = await h.run(["--out-dir", RUN, "--live"]);
    expect(r).toMatchObject({
      exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
      watchStatus: "NO_QUALIFYING_NOTIFICATION_OBSERVED",
      validationOutcome: null,
      terminalCause: { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH" },
      seal: { ok: true },
      verification: {
        integrity: { ok: true },
        completeness: { sufficientForSelection: false },
        selectionConfirmed: false,
        confirmedTarget: null,
      },
    });
    const watch = readJson(h, WATCH_EVIDENCE_FILES.watchObservations);
    expect(JSON.stringify(watch)).toContain(`"endedAtMs":${START_MS + 900_000}`);
    expect(h.calls).toEqual([]);
    expect(h.transports).toHaveLength(1);
    expectNoSecrets(h);
    expectCleanedUp(h, r);
  });

  it("E-05: cancellation is sealed with its true cause at every stage and boundary", async () => {
    const cases: [
      string,
      (h: Harness) => Partial<FreshAmmV4WatchDeps>,
      Record<string, unknown>,
      number,
    ][] = [
      [
        "before the watch starts",
        (h) => ({ onStage: (s) => s === "BEFORE_WATCH" && h.controller.abort() }),
        {
          watchStatus: "OPERATOR_CANCELLED",
          terminalCause: { code: "OPERATOR_CANCELLED", stage: "WATCH" },
        },
        0,
      ],
      [
        "during the watch",
        (h) => {
          h.sched.at(START_MS + 5_000, () => h.controller.abort());
          return {};
        },
        {
          watchStatus: "OPERATOR_CANCELLED",
          terminalCause: { code: "OPERATOR_CANCELLED", stage: "WATCH" },
        },
        0,
      ],
      [
        "after capture, before validation",
        (h) => ({ onStage: (s) => s === "AFTER_WATCH" && h.controller.abort() }),
        {
          watchStatus: "NOTIFICATION_CAPTURED",
          validationOutcome: null,
          terminalCause: { code: "OPERATOR_CANCELLED", stage: "RUN" },
        },
        0,
      ],
      [
        "during validation (transaction request in flight)",
        (h) => {
          h.sched.at(NOTIFY_AT + 500, () => h.controller.abort());
          return {};
        },
        {
          validationOutcome: "OPERATOR_CANCELLED",
          terminalCause: { code: "OPERATOR_CANCELLED", stage: "VALIDATION" },
        },
        1,
      ],
    ];
    for (const [label, setup, expected, requests] of cases) {
      const h = harness({ fetch: { rpcDelayMs: 1_000 } });
      const r = await h.run(["--out-dir", RUN, "--live"], setup(h));
      expect(r, label).toMatchObject({
        exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
        seal: { ok: true },
        verification: { integrity: { ok: true }, selectionConfirmed: false },
        ...expected,
      });
      expect(h.calls, label).toHaveLength(requests);
      if (label === "before the watch starts") expect(h.transports, label).toEqual([]);
      expectNoSecrets(h);
      expectCleanedUp(h, r);
    }

    // After validation finished, from either hook (the review reproduction): the completed
    // validation and both exchanges are sealed unchanged, but the run is sealed as cancelled at
    // RUN, is not selected, is not confirmed and is refused by the watched handoff.
    for (const boundary of ["AFTER_VALIDATION", "BEFORE_SEAL"] as const) {
      const h = harness();
      const r = await h.run(["--out-dir", RUN, "--live"], {
        onStage: (s) => s === boundary && h.controller.abort(),
      });
      expect(r, boundary).toMatchObject({
        exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
        validationOutcome: "TARGET_SELECTED",
        terminalCause: {
          code: "OPERATOR_CANCELLED",
          stage: "RUN",
          detail: "Operator cancellation after validation finished, before sealing",
        },
        cancellationAfterValidation: true,
        seal: { ok: true, status: "SEALED" },
        verification: {
          integrity: { ok: true, problems: [] },
          completeness: {
            sufficientForSelection: false,
            reasons: ["TERMINAL_CAUSE:OPERATOR_CANCELLED"],
          },
          rederivation: "REPRODUCED",
          selectionConfirmed: false,
          confirmedTarget: null,
        },
      });
      expect(h.calls, boundary).toHaveLength(2);
      expect(readJson(h, WATCH_EVIDENCE_FILES.selection), boundary).toMatchObject({
        selected: false,
        recordedOutcome: "TARGET_SELECTED",
        runOutcome: "OPERATOR_CANCELLED",
        terminalCause: { code: "OPERATOR_CANCELLED", stage: "RUN" },
      });
      // Usable completed evidence is retained...
      const v = verifyWatchEvidence(h.abs(RUN));
      expect(readJson(h, WATCH_EVIDENCE_FILES.validation).result).toMatchObject({
        outcome: "TARGET_SELECTED",
        target: { poolId: POOL, mintAddress: MINT },
      });
      expect(existsSync(path.join(h.abs(RUN), "exchanges", "0001.json"))).toBe(true);
      expect(existsSync(path.join(h.abs(RUN), "exchanges", "0002.json"))).toBe(true);
      expect(v).toMatchObject({ verified: true, selectionConfirmed: false, confirmedTarget: null });
      // ...without authorizing continuation.
      const handoff = evaluateWatchedPilotHandoff({
        projectRoot: h.projectRoot,
        watchEvidenceDir: RUN,
        pilotOutDir: "data/research/single-candidate/pilot-after-cancel",
        pinnedCommit: "a".repeat(40),
        clock: () => (Math.floor((START_MS - 300_000) / 1000) + 300) * 1000,
        git: allowedGit,
      });
      expect(handoff.decision, boundary).toBe("REFUSED");
      expect(handoff.poolId, boundary).toBeUndefined();
      expect(handoff.mintAddress, boundary).toBeUndefined();
      expect(handoff.refusals, boundary).toEqual([
        "WATCH_EVIDENCE_INCOMPLETE:TERMINAL_CAUSE:OPERATOR_CANCELLED",
        "WATCH_SELECTION_NOT_CONFIRMED",
      ]);
      expect(
        h.lines.some((l) => l.includes("sealed as OPERATOR_CANCELLED and is not actionable")),
        boundary,
      ).toBe(true);
      expectNoSecrets(h);
      expectCleanedUp(h, r);
      // Verifying the cancelled run reports exit 3; after tampering, the integrity exit 4.
      expect((await h.run(["--verify", RUN])).exitCode, boundary).toBe(
        WATCH_EXIT_CODES.NOT_CONFIRMED,
      );
      const selection = path.join(h.abs(RUN), WATCH_EVIDENCE_FILES.selection);
      writeFileSync(selection, readFileSync(selection, "utf8").replace(POOL, MINT));
      expect((await h.run(["--verify", RUN])).exitCode, boundary).toBe(
        WATCH_EXIT_CODES.INTEGRITY_FAILED,
      );
    }

    // An earlier cause is kept when cancellation is also observed before sealing.
    const earlier: [string, Parameters<typeof harness>[0], Record<string, unknown>][] = [
      [
        "no capture",
        { script: [{ atMs: 600, data: ACK }] },
        { terminalCause: { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH" } },
      ],
      [
        "failed cleanup",
        { transport: { throwOnClose: true, stayOpen: true } },
        { terminalCause: { code: "RUN_FAILED", stage: "WATCH" } },
      ],
    ];
    for (const [label, options, expected] of earlier) {
      const h = harness(options);
      const r = await h.run(["--out-dir", RUN, "--live"], {
        onStage: (s) => s === "BEFORE_SEAL" && h.controller.abort(),
      });
      expect(r, label).toMatchObject({
        exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
        cancellationAfterValidation: false,
        seal: { ok: true },
        ...expected,
      });
    }
    // A cancelled validation keeps its VALIDATION-stage cause.
    const inValidation = harness({ fetch: { rpcDelayMs: 1_000 } });
    inValidation.sched.at(NOTIFY_AT + 500, () => inValidation.controller.abort());
    const cancelled = await inValidation.run(["--out-dir", RUN, "--live"]);
    expect(cancelled).toMatchObject({
      terminalCause: { code: "OPERATOR_CANCELLED", stage: "VALIDATION" },
      cancellationAfterValidation: false,
    });

    // A write failure keeps its exit code for a cancelled run; sealing itself is not interrupted
    // (the failure is the writer's, reported once, with the cancelled cause).
    const failing = harness();
    let writes = 0;
    const w = await failing.run(["--out-dir", RUN, "--live"], {
      onStage: (s) => s === "BEFORE_SEAL" && failing.controller.abort(),
      writeEvidenceFile: (file, content, options) => {
        writes++;
        if (file.replace(/\\/g, "/").endsWith("exchanges/0002.json")) {
          throw new Error("SYNTHETIC disk full");
        }
        writeFileSync(file, content, options);
      },
    });
    expect(writes).toBeGreaterThan(1);
    expect(failing.calls).toHaveLength(2);
    expect(w).toMatchObject({
      exitCode: WATCH_EXIT_CODES.SEAL_FAILED,
      terminalCause: { code: "OPERATOR_CANCELLED", stage: "RUN" },
      seal: { ok: false, status: "ARTIFACT_WRITE_FAILED" },
    });
  });

  it("E-06: request failures are recorded once, sealed as validation rejections and never retried", async () => {
    const rpc = harness({ fetch: { rpcStatus: 503 } });
    const a = await rpc.run(["--out-dir", RUN, "--live"]);
    expect(a).toMatchObject({
      exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
      validationOutcome: "TRANSACTION_REQUEST_FAILED",
      terminalCause: { code: "COMPLETED", stage: "VALIDATION" },
      verification: {
        integrity: { ok: true },
        rederivation: "REPRODUCED",
        selectionConfirmed: false,
      },
    });
    expect(rpc.calls).toHaveLength(1);
    expectCleanedUp(rpc, a);

    const market = harness({ fetch: { marketThrows: true } });
    const b = await market.run(["--out-dir", RUN, "--live"]);
    expect(b).toMatchObject({
      exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
      validationOutcome: "MARKET_REQUEST_FAILED",
      verification: { integrity: { ok: true }, selectionConfirmed: false },
    });
    expect(market.calls).toHaveLength(2);
    expect(readJson(market, "exchanges/0002.json").error).not.toBeNull();
    expectNoSecrets(market);
    expectCleanedUp(market, b);

    // A request slower than the 10 s timeout is cut off, not retried.
    const slow = harness({ fetch: { rpcDelayMs: 12_000 } });
    const c = await slow.run(["--out-dir", RUN, "--live"]);
    expect(c.validationOutcome).toBe("TRANSACTION_REQUEST_FAILED");
    expect(slow.calls).toHaveLength(1);
    expect(readJson(slow, "exchanges/0001.json").error).toBe("REQUEST_TIMED_OUT");
    expectCleanedUp(slow, c);
  });

  it("E-07: the validation deadline (notification + 30 s, never beyond watch start + 930 s) bounds the stages", async () => {
    // A slow boundary after capture consumes the window: nothing is sent.
    const late = harness();
    const a = await late.run(["--out-dir", RUN, "--live"], {
      onStage: (s) => {
        if (s === "AFTER_WATCH") late.sched.now = NOTIFY_AT + 31_000;
      },
    });
    expect(a).toMatchObject({
      validationOutcome: "VALIDATION_DEADLINE_EXPIRED",
      terminalCause: { code: "COMPLETED", stage: "VALIDATION" },
      verification: { integrity: { ok: true }, selectionConfirmed: false },
    });
    expect(late.calls).toEqual([]);
    expectCleanedUp(late, a);

    // The deadline cuts off an in-flight request.
    const inflight = harness({ fetch: { rpcDelayMs: 9_000 } });
    const b = await inflight.run(["--out-dir", RUN, "--live"], {
      onStage: (s) => {
        if (s === "AFTER_WATCH") inflight.sched.now = NOTIFY_AT + 25_000;
      },
    });
    expect(b.validationOutcome).toBe("VALIDATION_DEADLINE_EXPIRED");
    expect(inflight.calls).toHaveLength(1);
    const validation = readJson(inflight, WATCH_EVIDENCE_FILES.validation);
    expect(validation.result.validationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);
    expect(validation.result.completedAtMs).toBeLessThanOrEqual(NOTIFY_AT + 30_000);
    expectCleanedUp(inflight, b);

    // A notification just before the ceiling: the deadline is the earlier of the two bounds.
    const edge = harness({
      script: [
        { atMs: 600, data: ACK },
        { atMs: 899_000, data: NOTIFICATION },
      ],
    });
    const c = await edge.run(["--out-dir", RUN, "--live"]);
    const deadline = readJson(edge, WATCH_EVIDENCE_FILES.validation).result.validationDeadlineAtMs;
    expect(deadline).toBe(Math.min(START_MS + 899_000 + 30_000, START_MS + 930_000));
    expect(deadline).toBeLessThanOrEqual(START_MS + OVERALL_SESSION_DEADLINE_MS);
    expect(c.seal?.ok).toBe(true);
    expectCleanedUp(edge, c);
  });

  it("E-08: a capture whose cleanup failed is sealed as a run failure without validation", async () => {
    const h = harness({ transport: { throwOnClose: true, stayOpen: true } });
    const r = await h.run(["--out-dir", RUN, "--live"]);
    expect(r).toMatchObject({
      exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
      watchStatus: "NOTIFICATION_CAPTURED",
      validationOutcome: null,
      terminalCause: { code: "RUN_FAILED", stage: "WATCH" },
      seal: { ok: true },
      verification: { integrity: { ok: true }, selectionConfirmed: false },
    });
    expect(r.terminalCause?.detail).toMatch(/^COLLECTOR_CLEANUP_NOT_SETTLED/);
    expect(h.calls).toEqual([]);
    // The entry point tried to close what the collector could not, and reports the result.
    expect(r.cleanup).toEqual({
      transportsOpened: 1,
      transportsForceClosed: 1,
      transportsStillOpen: 1,
    });
    expect(h.sched.count("provider")).toBe(0);
    expectNoSecrets(h);
  });

  it("E-09: an artifact-write failure is explicit and never triggers reacquisition", async () => {
    const h = harness();
    let writes = 0;
    const r = await h.run(["--out-dir", RUN, "--live"], {
      writeEvidenceFile: (file, content, options) => {
        writes++;
        if (file.replace(/\\/g, "/").endsWith("exchanges/0002.json")) {
          throw new Error("SYNTHETIC disk full");
        }
        writeFileSync(file, content, options);
      },
    });
    expect(r).toMatchObject({
      exitCode: WATCH_EXIT_CODES.SEAL_FAILED,
      validationOutcome: "TARGET_SELECTED",
      terminalCause: { code: "COMPLETED", stage: "VALIDATION" },
      seal: { ok: false, status: "ARTIFACT_WRITE_FAILED", manifestSha256: null },
    });
    expect(r.verification).toBeUndefined();
    expect(writes).toBeGreaterThan(0);
    expect(h.transports).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(existsSync(path.join(h.abs(RUN), WATCH_EVIDENCE_FILES.manifest))).toBe(false);
    expectNoSecrets(h);
    expectCleanedUp(h, r);

    // The output directory appearing during the run is refused by the sealer, also not retried.
    const raced = harness();
    const s = await raced.run(["--out-dir", RUN, "--live"], {
      onStage: (stage) => stage === "BEFORE_SEAL" && mkdirSync(raced.abs(RUN), { recursive: true }),
    });
    expect(s).toMatchObject({ exitCode: WATCH_EXIT_CODES.SEAL_FAILED, seal: { ok: false } });
    expect(raced.calls).toHaveLength(2);
    expect(readdirSync(raced.abs(RUN))).toEqual([]);
  });

  it("E-10: --verify reports integrity, completeness and selection separately, offline", async () => {
    const h = harness();
    await h.run(["--out-dir", RUN, "--live"]);
    const loadsAfterLive = h.loads();
    h.lines.length = 0;
    const ok = await h.run(["--verify", RUN]);
    expect(ok).toMatchObject({
      mode: "VERIFY",
      exitCode: WATCH_EXIT_CODES.OK,
      verification: { integrity: { ok: true }, selectionConfirmed: true },
    });
    expect(h.lines).toEqual([
      "[VERIFY] Integrity: OK",
      "[VERIFY] Completeness: SUFFICIENT",
      "[VERIFY] Re-derivation: REPRODUCED",
      `[VERIFY] Selection: CONFIRMED (PROVISIONAL target: pool ${POOL} mint ${MINT})`,
    ]);
    const selection = path.join(h.abs(RUN), WATCH_EVIDENCE_FILES.selection);
    writeFileSync(selection, readFileSync(selection, "utf8").replace(POOL, MINT));
    const bad = await h.run(["--verify", RUN]);
    expect(bad).toMatchObject({
      exitCode: WATCH_EXIT_CODES.INTEGRITY_FAILED,
      verification: { integrity: { ok: false }, selectionConfirmed: false, confirmedTarget: null },
    });
    await expect(h.run(["--verify", "data/research/single-candidate/x"])).rejects.toThrow(
      /^\[CLI_INVALID_ARG\]/,
    );
    expect(h.loads()).toBe(loadsAfterLive);
    expect(h.transports).toHaveLength(1);
  });
  it("E-11: an explicit WebSocket endpoint is used as configured; Alchemy needs it; HTTP stays on the RPC endpoint", async () => {
    // Distinct hosts and credentials: HTTP on the RPC host, the watch on the streaming host.
    const STREAM_KEY = "SYNTHETIC-stream-key-246813579";
    const STREAM_URL = `wss://stream.synthetic.invalid/v2/${STREAM_KEY}`;
    const h = harness({
      env: { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: STREAM_URL },
      expectWsUrl: STREAM_URL,
    });
    const r = await h.run(["--out-dir", RUN, "--live"]);
    expect(r).toMatchObject({
      exitCode: WATCH_EXIT_CODES.OK,
      validationOutcome: "TARGET_SELECTED",
      verification: { integrity: { ok: true }, selectionConfirmed: true },
    });
    expect(h.transports).toHaveLength(1);
    // The two requests go to the RPC endpoint and the market endpoint only, exactly as before.
    expect(h.calls.map((c) => c.url)).toEqual([
      RPC_URL,
      `https://api.dexscreener.com/latest/dex/tokens/${MINT}`,
    ]);
    expect(rpcMethods(h)).toEqual(["getTransaction"]);
    // Neither credential, nor either URL, is printed or stored.
    const secrets = [...SECRETS, STREAM_URL, STREAM_KEY];
    for (const line of h.lines) for (const s of secrets) expect(line.includes(s), line).toBe(false);
    for (const f of listFiles(h.abs(RUN))) {
      const text = readFileSync(path.join(h.abs(RUN), ...f.split("/")), "utf8");
      for (const s of secrets) expect(text.includes(s), `${s} in ${f}`).toBe(false);
    }
    expect(readJson(h, WATCH_EVIDENCE_FILES.plan).endpoints.webSocket).toMatch(
      /^SOLANA_WS_URL \(configuration; never printed\), required for Alchemy RPC hosts/,
    );
    expectCleanedUp(h, r);

    // A transport failure whose message carries the explicit endpoint: the sealer redacts the
    // WebSocket credential it was given, in the sealed cause and the observations.
    const failing = harness({
      env: { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: STREAM_URL },
      expectWsUrl: STREAM_URL,
    });
    const f = await failing.run(["--out-dir", RUN, "--live"], {
      createWebSocketTransport: (url: string) => {
        throw new Error(`SYNTHETIC connect failure to ${url}`);
      },
    });
    expect(f).toMatchObject({
      exitCode: WATCH_EXIT_CODES.NOT_CONFIRMED,
      watchStatus: "TRANSPORT_ERROR",
      terminalCause: { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH" },
      seal: { ok: true },
    });
    expect(f.terminalCause?.detail).toContain("SYNTHETIC connect failure");
    expect(failing.calls).toEqual([]);
    for (const line of failing.lines)
      for (const s of secrets) expect(line.includes(s), line).toBe(false);
    for (const file of listFiles(failing.abs(RUN))) {
      const text = readFileSync(path.join(failing.abs(RUN), ...file.split("/")), "utf8");
      for (const s of secrets) expect(text.includes(s), `${s} in ${file}`).toBe(false);
    }
    expect(JSON.stringify(readJson(failing, WATCH_EVIDENCE_FILES.watchObservations))).toContain(
      "SYNTHETIC connect failure to [REDACTED]",
    );

    // Refused before any transport, request or write.
    const ALCHEMY_RPC = "https://solana-mainnet.g.alchemy.com/v2/SYNTHETIC-alchemy-key-1357";
    for (const [env, message] of [
      [{ SOLANA_RPC_URL: ALCHEMY_RPC }, SOLANA_ENDPOINT_ERRORS.wsRequired],
      [{ SOLANA_RPC_URL: ALCHEMY_RPC, SOLANA_WS_URL: "" }, SOLANA_ENDPOINT_ERRORS.wsRequired],
      [
        { SOLANA_RPC_URL: ALCHEMY_RPC, SOLANA_WS_URL: "ws://stream.synthetic.invalid/x" },
        SOLANA_ENDPOINT_ERRORS.wsDowngrade,
      ],
      [
        { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: "https://stream.synthetic.invalid/x" },
        SOLANA_ENDPOINT_ERRORS.wsInvalid,
      ],
      [{ SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: "wss://" }, SOLANA_ENDPOINT_ERRORS.wsInvalid],
      [
        { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: " wss://stream.synthetic.invalid/x" },
        SOLANA_ENDPOINT_ERRORS.wsInvalid,
      ],
      [{ SOLANA_WS_URL: STREAM_URL }, SOLANA_ENDPOINT_ERRORS.rpc],
    ] as const) {
      const c = harness({ env });
      const err = await c.run(["--out-dir", RUN, "--live"]).catch((e: unknown) => e);
      expect((err as Error).message, JSON.stringify(Object.keys(env))).toBe(message);
      expect(printableError(err)).toBe(message);
      expect(c.loads()).toBe(1);
      expect(c.transports).toEqual([]);
      expect(c.calls).toEqual([]);
      expect(readdirSync(c.projectRoot)).toEqual([]);
    }
    // The Alchemy RPC host with its explicit streaming endpoint is accepted (no request here).
    expect(
      resolveSolanaEndpoints({ SOLANA_RPC_URL: ALCHEMY_RPC, SOLANA_WS_URL: STREAM_URL }),
    ).toEqual({ ok: true, rpcUrl: ALCHEMY_RPC, wsUrl: STREAM_URL, wsSource: "SOLANA_WS_URL" });
  });
});
