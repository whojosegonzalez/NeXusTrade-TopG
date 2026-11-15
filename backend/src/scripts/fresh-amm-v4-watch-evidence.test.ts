/**
 * Watch evidence artifact layer (offline). Discovery evidence is GENUINE output of the reviewed
 * collector on a scripted in-memory transport; validation is the reviewed executor against a
 * scripted fetch on the shared virtual scheduler. Every key, response and value is SYNTHETIC.
 * Artifacts are written only into this test's own OS temporary directories. No real network,
 * socket, daemon, credential or capture.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  sealWatchEvidence,
  verifyWatchEvidence,
  WATCH_EVIDENCE_FILES,
  WATCH_EVIDENCE_REQUIRED_FILES,
  type SealWatchEvidenceInput,
  type WatchRunTerminalCause,
} from "./fresh-amm-v4-watch-evidence.js";
import {
  executeWatchCandidateValidation,
  type WatchCandidateValidationResult,
  type WatchEvidenceContext,
} from "../candidate-scanner/AmmV4WatchCandidateValidation.js";
import {
  BoundedAmmV4CreationWatch,
  type BoundedAmmV4CreationWatchLimits,
} from "../candidate-scanner/BoundedAmmV4CreationWatch.js";
import type { ISolanaKeepaliveWebSocketTransport } from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import { PRECHECK_ROOT_SEGMENTS } from "./fresh-amm-v4-precheck.js";
import {
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
const NOTIFY_AT = START_MS + 10_000;
const RPC_KEY = "SYNTHETIC-secret-key-123";
const WSS_KEY = "SYNTHETIC-wss-key-456789";
const RPC_URL = `${TEST_RPC_URL}/?key=${RPC_KEY}`;
const WSS_URL = `wss://synthetic.invalid/watch?api-key=${WSS_KEY}`;
const CREDENTIALS = Object.freeze({ rpcUrl: RPC_URL, wssUrl: WSS_URL });
const SECRETS = [RPC_URL, WSS_URL, RPC_KEY, WSS_KEY];
const PLAN = Object.freeze({
  kind: "SYNTHETIC_WATCH_RUN_PLAN",
  mode: "OFFLINE_TEST",
  watch: "one logsSubscribe, reviewed limits",
});
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------
// SYNTHETIC collector + validator harness (copied from the reviewed validation tests)
// ---------------------------------------------------------------------------------------------

class ScriptedTransport implements ISolanaKeepaliveWebSocketTransport {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((...args: never[]) => void)[]> = {};
  on = ((event: string, listener: (...args: never[]) => void) => {
    (this.listeners[event] ??= []).push(listener);
  }) as ISolanaKeepaliveWebSocketTransport["on"];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
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
}

const ACK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 });
const notificationFrame = (logs: readonly string[] = ["Program log: initialize2"]) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: 42,
      result: { context: { slot: 250_000 }, value: { err: null, signature: SIG, logs } },
    },
  });

async function captureWatch(
  o: {
    script?: readonly { atMs: number; data: string }[];
    limits?: Partial<BoundedAmmV4CreationWatchLimits>;
    abortAtMs?: number;
  } = {},
) {
  const sched = new VirtualScheduler(START_MS);
  const transport = new ScriptedTransport();
  const controller = new AbortController();
  const watch = new BoundedAmmV4CreationWatch({
    wssUrl: "wss://synthetic.invalid/watch",
    clock: () => sched.now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "harness"),
      clearTimeout: (h: unknown) => sched.clear(h),
    },
    transportFactory: () => transport,
    abortSignal: controller.signal,
    ...(o.limits ? { limits: o.limits } : {}),
  });
  const running = watch.start();
  transport.open();
  const script = o.script ?? [
    { atMs: 600, data: ACK },
    { atMs: 10_000, data: notificationFrame() },
  ];
  for (const s of script) sched.at(START_MS + s.atMs, () => transport.message(s.data));
  if (o.abortAtMs !== undefined) sched.at(START_MS + o.abortAtMs, () => controller.abort());
  const watchResult = await drive(sched, running);
  const timers = {
    setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
    clearTimeout: (h: unknown) => sched.clear(h),
  };
  return { sched, timers, watchResult };
}
type Env = Awaited<ReturnType<typeof captureWatch>>;

function makeMockFetch(
  sched: VirtualScheduler,
  o: {
    rpcStatus?: number;
    rpcRawBody?: Buffer;
    marketResponse?: unknown;
    marketRawBody?: Buffer;
    calls?: string[];
  } = {},
) {
  const delay = (signal?: AbortSignal | null) =>
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
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    o.calls?.push(url);
    await delay(init?.signal);
    if (url.startsWith(TEST_RPC_URL)) {
      if (o.rpcStatus !== undefined && o.rpcStatus !== 200) {
        return new Response(JSON.stringify({ error: "RPC error" }), { status: o.rpcStatus });
      }
      if (o.rpcRawBody) return new Response(new Uint8Array(o.rpcRawBody), { status: 200 });
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
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
    if (o.marketRawBody) return new Response(new Uint8Array(o.marketRawBody), { status: 200 });
    return new Response(JSON.stringify(o.marketResponse ?? marketResponse(START_MS - 300_000)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function validate(
  env: Env,
  fetchFn: typeof fetch,
  extra: { abortSignal?: AbortSignal; limits?: WatchEvidenceContext["limits"] } = {},
): Promise<WatchCandidateValidationResult> {
  return drive(
    env.sched,
    executeWatchCandidateValidation({
      watchResult: env.watchResult,
      rpcUrl: RPC_URL,
      clock: () => env.sched.now,
      timers: env.timers,
      fetchFn,
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Temporary project roots and artifact helpers
// ---------------------------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tempRoot(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), "watch-evidence-test-"));
  roots.push(r);
  return r;
}
const runDir = (root: string, name: string) => path.join(root, ...PRECHECK_ROOT_SEGMENTS, name);

const COMPLETED: WatchRunTerminalCause = { code: "COMPLETED", stage: "VALIDATION", detail: null };

function seal(over: Partial<SealWatchEvidenceInput> & Pick<SealWatchEvidenceInput, "watchResult">) {
  const projectRoot = over.projectRoot ?? tempRoot();
  const runName = over.runName ?? "watch-run-01";
  const result = sealWatchEvidence({
    projectRoot,
    runName,
    plan: PLAN,
    validation: null,
    terminalCause: COMPLETED,
    credentials: CREDENTIALS,
    clock: () => START_MS + 60_000,
    ...over,
  });
  return { result, projectRoot, dir: runDir(projectRoot, runName) };
}

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => {
    const p = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? listFiles(dir, p) : [p];
  });
}

/** Every stored byte (and every base64 body decoded) is free of every credential form. */
function expectNoSecrets(dir: string): void {
  for (const f of listFiles(dir)) {
    const text = readFileSync(path.join(dir, ...f.split("/")), "utf8");
    for (const s of SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
    const doc = JSON.parse(text) as Loose;
    if (doc?.response?.bodyEncoding === "base64") {
      const decoded = Buffer.from(doc.response.body as string, "base64").toString("latin1");
      for (const s of SECRETS) expect(decoded.includes(s), `${s} decoded in ${f}`).toBe(false);
    }
  }
}

const readJson = (dir: string, rel: string): Loose =>
  JSON.parse(readFileSync(path.join(dir, ...rel.split("/")), "utf8"));

/** Copies a sealed run (offline tampering fixtures). */
function copyRun(dir: string, name: string): string {
  const target = path.join(path.dirname(dir), name);
  cpSync(dir, target, { recursive: true });
  return target;
}

/**
 * Re-forges a sealed run: edits JSON documents and recomputes their manifest entries, so the
 * hashes agree and only the edited semantics differ.
 */
function reforge(dir: string, edits: Record<string, (doc: Loose) => void>): void {
  const manifest = readJson(dir, WATCH_EVIDENCE_FILES.manifest);
  for (const [rel, edit] of Object.entries(edits)) {
    const doc = readJson(dir, rel);
    edit(doc);
    const content = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(path.join(dir, ...rel.split("/")), content);
    const entry = (manifest.files as Loose[]).find((e) => e.path === rel);
    if (entry) {
      entry.sha256 = sha256(content);
      entry.bytes = Buffer.byteLength(content);
    }
  }
  writeFileSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest), JSON.stringify(manifest, null, 2));
}

function editManifest(dir: string, edit: (m: Loose) => void): void {
  const m = readJson(dir, WATCH_EVIDENCE_FILES.manifest);
  edit(m);
  writeFileSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest), JSON.stringify(m, null, 2));
}

async function selectedRun() {
  const env = await captureWatch();
  const calls: string[] = [];
  const validation = await validate(env, makeMockFetch(env.sched, { calls }));
  expect(validation.outcome).toBe("TARGET_SELECTED");
  return { env, validation, calls };
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("fresh AMM v4 watch evidence (offline sealing and verification)", () => {
  it("W-01: a selected run seals exclusively, round-trips and re-derives the recorded target", async () => {
    const { env, validation, calls } = await selectedRun();
    const { result, dir, projectRoot } = seal({ watchResult: env.watchResult, validation });
    expect(result).toMatchObject({
      ok: true,
      status: "SEALED",
      sealed: true,
      recordedOutcome: "TARGET_SELECTED",
    });
    expect(calls).toHaveLength(2); // sealing triggers no acquisition

    const files = listFiles(dir).sort();
    expect(files).toEqual(
      [
        ...WATCH_EVIDENCE_REQUIRED_FILES,
        WATCH_EVIDENCE_FILES.manifest,
        "exchanges/0001.json",
        "exchanges/0002.json",
      ].sort(),
    );
    expectNoSecrets(dir);

    // Observations, identity, raw bodies, context and termination are preserved.
    const watch = readJson(dir, WATCH_EVIDENCE_FILES.watchObservations);
    expect(watch.watchResult.observations.applicationFrames).toEqual(
      JSON.parse(JSON.stringify(env.watchResult.observations.applicationFrames)),
    );
    expect(watch.frameRedactions).toEqual([]);
    const tx = readJson(dir, "exchanges/0001.json");
    expect(tx.request).toEqual({
      method: "POST",
      url: "SOLANA_RPC_URL (configuration; not recorded)",
      headersRecorded: false,
      rpcMethod: "getTransaction",
      rpcParams: validation.exchanges[0]!.request.rpcParams,
    });
    expect(tx.response).toMatchObject({
      bodyState: "COMPLETE",
      bodyEncoding: "utf8",
      bodyRedacted: false,
      reproducesReceivedDigest: true,
      receivedDigestScope: "ORIGINAL_COMPLETE_BODY_BYTES",
      body: validation.exchanges[0]!.response.body,
    });
    expect(tx.response.sanitizedBytesSha256).toBe(tx.response.receivedBytesSha256);
    const context = readJson(dir, WATCH_EVIDENCE_FILES.context);
    expect(context.recordedValidationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);
    expect(context.recomputedValidationDeadlineAtMs).toBe(NOTIFY_AT + 30_000);
    const selection = readJson(dir, WATCH_EVIDENCE_FILES.selection);
    expect(selection).toMatchObject({
      discoveryMode: "WATCH_LOGS_SUBSCRIBE",
      terminalCause: COMPLETED,
      runOutcome: "TARGET_SELECTED",
      watchStatus: "NOTIFICATION_CAPTURED",
      selected: true,
    });
    expect(selection.target).toEqual(JSON.parse(JSON.stringify(validation.target)));
    const report = readJson(dir, WATCH_EVIDENCE_FILES.report);
    expect(report.redaction).toMatchObject({
      applied: false,
      reproducible: true,
      limitation: null,
    });
    expect(report.planDigestSha256).toBe(sha256(readFileSync(path.join(dir, "plan.json"))));

    const v = verifyWatchEvidence(dir);
    expect(v.integrity).toEqual({ ok: true, problems: [] });
    expect(v.completeness).toEqual({ sufficientForSelection: true, reasons: [] });
    expect(v.rederivation).toMatchObject({
      status: "REPRODUCED",
      rederivedOutcome: "TARGET_SELECTED",
    });
    expect(v).toMatchObject({
      verified: true,
      selectionConfirmed: true,
      runOutcome: "TARGET_SELECTED",
    });

    // Never overwrite: the same directory is refused and the sealed bytes are unchanged.
    const manifestBefore = readFileSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest));
    const again = seal({ projectRoot, watchResult: env.watchResult, validation });
    expect(again.result).toMatchObject({
      ok: false,
      status: "OUTPUT_DIRECTORY_UNAVAILABLE",
      sealed: false,
    });
    expect(readFileSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest)).equals(manifestBefore)).toBe(
      true,
    );

    // A policy context that does not reproduce the recorded deadline is refused before writing.
    const wrongContext = seal({
      watchResult: env.watchResult,
      validation,
      policyContext: { overallDeadlineAtMs: NOTIFY_AT + 5_000 },
    });
    expect(wrongContext.result).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID" });
    expect(existsSync(wrongContext.dir)).toBe(false);
    // Exchange records that disagree with the validation result are refused.
    const mismatched = seal({
      watchResult: env.watchResult,
      validation,
      exchanges: validation.exchanges.slice(0, 1),
    });
    expect(mismatched.result).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID" });
    expect(existsSync(mismatched.dir)).toBe(false);
  });

  it("W-02: a watch that ended without a notification seals truthfully and is not eligible for selection", async () => {
    const env = await captureWatch({
      script: [{ atMs: 600, data: ACK }],
      limits: { watchCeilingMs: 20_000 },
    });
    expect(env.watchResult.status).toBe("NO_QUALIFYING_NOTIFICATION_OBSERVED");
    const cause: WatchRunTerminalCause = {
      code: "WATCH_ENDED_WITHOUT_CAPTURE",
      stage: "WATCH",
      detail: null,
    };
    const { result, dir } = seal({ watchResult: env.watchResult, terminalCause: cause });
    expect(result).toMatchObject({ ok: true, sealed: true, recordedOutcome: null });
    expect(listFiles(dir).some((f) => f.startsWith("exchanges/"))).toBe(false);
    expect(readJson(dir, WATCH_EVIDENCE_FILES.validation)).toMatchObject({
      recorded: false,
      result: null,
    });
    expect(readJson(dir, WATCH_EVIDENCE_FILES.requestLedger)).toMatchObject({
      httpAttempts: 0,
      entries: [],
    });

    const v = verifyWatchEvidence(dir);
    expect(v.integrity.ok).toBe(true);
    expect(v.completeness.sufficientForSelection).toBe(false);
    expect(v.completeness.reasons).toEqual([
      "TERMINAL_CAUSE:WATCH_ENDED_WITHOUT_CAPTURE",
      "WATCH_DID_NOT_CAPTURE:NO_QUALIFYING_NOTIFICATION_OBSERVED",
      "VALIDATION_NOT_RECORDED",
      "OUTCOME:NONE",
    ]);
    expect(v.rederivation.status).toBe("NOT_ELIGIBLE");
    expect(v).toMatchObject({
      verified: true,
      selectionConfirmed: false,
      runOutcome: "WATCH_ENDED_WITHOUT_CAPTURE",
    });

    // Mislabelled causes are refused before anything is written.
    for (const wrong of [
      COMPLETED,
      { code: "OPERATOR_CANCELLED", stage: "WATCH", detail: null },
    ] as const) {
      const s = seal({ watchResult: env.watchResult, terminalCause: wrong });
      expect(s.result).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID" });
      expect(existsSync(s.dir)).toBe(false);
    }
  });

  it("W-03: cancellation and run failure are preserved; usable partial evidence never becomes TARGET_SELECTED", async () => {
    // (a) Operator cancellation during the watch.
    const cancelledWatch = await captureWatch({
      script: [{ atMs: 600, data: ACK }],
      abortAtMs: 5_000,
    });
    expect(cancelledWatch.watchResult.status).toBe("OPERATOR_CANCELLED");
    const watchCause: WatchRunTerminalCause = {
      code: "OPERATOR_CANCELLED",
      stage: "WATCH",
      detail: "operator stop",
    };
    const a = seal({ watchResult: cancelledWatch.watchResult, terminalCause: watchCause });
    expect(a.result).toMatchObject({ ok: true, runCause: watchCause });
    const va = verifyWatchEvidence(a.dir);
    expect(va).toMatchObject({
      verified: true,
      selectionConfirmed: false,
      runOutcome: "OPERATOR_CANCELLED",
    });
    expect(va.terminalCause).toEqual(watchCause);
    const relabelled = seal({
      watchResult: cancelledWatch.watchResult,
      terminalCause: { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH", detail: null },
    });
    expect(relabelled.result).toMatchObject({
      status: "SEAL_INPUT_INVALID",
      reason: expect.stringContaining("CANCELLATION_NOT_PRESERVED"),
    });

    // (b) Operator cancellation while the transaction request is in flight.
    const inflight = await captureWatch();
    const controller = new AbortController();
    inflight.sched.at(NOTIFY_AT + 50, () => controller.abort());
    const cancelled = await validate(inflight, makeMockFetch(inflight.sched), {
      abortSignal: controller.signal,
    });
    expect(cancelled.outcome).toBe("OPERATOR_CANCELLED");
    const validationCause: WatchRunTerminalCause = {
      code: "OPERATOR_CANCELLED",
      stage: "VALIDATION",
      detail: null,
    };
    const b = seal({
      watchResult: inflight.watchResult,
      validation: cancelled,
      terminalCause: validationCause,
    });
    expect(b.result).toMatchObject({ ok: true, recordedOutcome: "OPERATOR_CANCELLED" });
    expect(readJson(b.dir, "exchanges/0001.json")).toMatchObject({ error: "REQUEST_ABORTED" });
    const vb = verifyWatchEvidence(b.dir);
    expect(vb.rederivation).toMatchObject({
      status: "NOT_ELIGIBLE",
      recordedOutcome: "OPERATOR_CANCELLED",
    });
    expect(vb.completeness.reasons).toContain("TERMINAL_CAUSE:OPERATOR_CANCELLED");
    expect(vb.completeness.reasons).toContain("OUTCOME:OPERATOR_CANCELLED");
    expect(vb).toMatchObject({
      verified: true,
      selectionConfirmed: false,
      recordedOutcome: "OPERATOR_CANCELLED",
    });

    // (c) Cancelled after complete, usable evidence: the outcome stays cancelled, no target.
    const { env, validation } = await selectedRun();
    const cancelledAfter: WatchCandidateValidationResult = {
      ...validation,
      ok: false,
      outcome: "OPERATOR_CANCELLED",
      reason: "OPERATOR_CANCELLED: INTERRUPTED_AFTER_RESPONSE",
      target: null,
    };
    const asCompleted = seal({
      watchResult: env.watchResult,
      validation: cancelledAfter,
      terminalCause: COMPLETED,
    });
    expect(asCompleted.result).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID" });
    const c = seal({
      watchResult: env.watchResult,
      validation: cancelledAfter,
      terminalCause: validationCause,
    });
    expect(c.result.ok).toBe(true);
    expect(readJson(c.dir, WATCH_EVIDENCE_FILES.selection)).toMatchObject({
      selected: false,
      target: null,
      runOutcome: "OPERATOR_CANCELLED",
    });
    const vc = verifyWatchEvidence(c.dir);
    expect(vc.rederivation.status).toBe("NOT_ELIGIBLE");
    expect(vc).toMatchObject({
      recordedOutcome: "OPERATOR_CANCELLED",
      runOutcome: "OPERATOR_CANCELLED",
      selectionConfirmed: false,
    });
    expect(vc.completeness.sufficientForSelection).toBe(false);

    // (d) A run failure after a selected validation keeps the failure; the detail is redacted.
    const failure: WatchRunTerminalCause = {
      code: "RUN_FAILED",
      stage: "RUN",
      detail: `handoff step failed while using ${RPC_URL}`,
    };
    const d = seal({ watchResult: env.watchResult, validation, terminalCause: failure });
    expect(d.result.ok).toBe(true);
    expectNoSecrets(d.dir);
    expect(readJson(d.dir, WATCH_EVIDENCE_FILES.selection)).toMatchObject({
      selected: false,
      runOutcome: "RUN_FAILED",
      recordedOutcome: "TARGET_SELECTED",
      terminalCause: { code: "RUN_FAILED", detail: "handoff step failed while using [REDACTED]" },
    });
    const vd = verifyWatchEvidence(d.dir);
    expect(vd.rederivation.status).toBe("REPRODUCED"); // the validation component itself reproduces
    expect(vd.completeness.reasons).toEqual(["TERMINAL_CAUSE:RUN_FAILED"]);
    expect(vd).toMatchObject({
      verified: true,
      selectionConfirmed: false,
      runOutcome: "RUN_FAILED",
    });
    const noDetail = seal({
      watchResult: env.watchResult,
      validation,
      terminalCause: { code: "RUN_FAILED", stage: "RUN", detail: " " },
    });
    expect(noDetail.result).toMatchObject({ status: "SEAL_INPUT_INVALID" });

    // (e) Re-forged records with consistent hashes are contradicted by re-derivation.
    const stopped = copyRun(c.dir, "reforged-stopped");
    reforge(stopped, {
      [WATCH_EVIDENCE_FILES.validation]: (doc) => {
        doc.result.outcome = "SESSION_STOPPED";
      },
      [WATCH_EVIDENCE_FILES.selection]: (doc) => {
        doc.terminalCause = COMPLETED;
        doc.recordedOutcome = "SESSION_STOPPED";
        doc.runOutcome = "SESSION_STOPPED";
      },
      [WATCH_EVIDENCE_FILES.report]: (doc) => {
        doc.terminalCause = COMPLETED;
        doc.recordedOutcome = "SESSION_STOPPED";
        doc.runOutcome = "SESSION_STOPPED";
      },
    });
    const vs = verifyWatchEvidence(stopped);
    expect(vs.integrity.ok).toBe(true);
    expect(vs.rederivation).toMatchObject({
      status: "MISMATCH",
      rederivedOutcome: "TARGET_SELECTED",
    });
    expect(vs).toMatchObject({
      verified: false,
      selectionConfirmed: false,
      recordedOutcome: "SESSION_STOPPED",
    });

    const sealedOk = seal({ watchResult: env.watchResult, validation });
    const forgedTarget = copyRun(sealedOk.dir, "reforged-target");
    const otherPool = "11111111111111111111111111111112";
    reforge(forgedTarget, {
      [WATCH_EVIDENCE_FILES.validation]: (doc) => {
        doc.result.target.poolId = otherPool;
      },
      [WATCH_EVIDENCE_FILES.selection]: (doc) => {
        doc.target.poolId = otherPool;
      },
    });
    const vt = verifyWatchEvidence(forgedTarget);
    expect(vt.integrity.ok).toBe(true);
    expect(vt.rederivation.status).toBe("MISMATCH");
    expect(vt).toMatchObject({ verified: false, selectionConfirmed: false });
  });

  it("W-04: partial bodies keep their retained prefix, prefix-only digest scope and truthful outcome", async () => {
    const limits = { dexscreenerMaxResponseBytes: 64 };
    const env = await captureWatch();
    const validation = await validate(env, makeMockFetch(env.sched), { limits });
    expect(validation.outcome).not.toBe("TARGET_SELECTED");
    const { result, dir } = seal({
      watchResult: env.watchResult,
      validation,
      policyContext: { limits },
    });
    expect(result.ok).toBe(true);
    const market = readJson(dir, "exchanges/0002.json");
    expect(market.response).toMatchObject({
      bodyState: "PARTIAL_OVERFLOW",
      completeEvidence: false,
      retainedBytes: 64,
      maxResponseBytes: 64,
      receivedDigestScope: "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
      bodyRedacted: false,
      reproducesReceivedDigest: true,
    });
    expect(market.response.receivedBytesSha256).toBe(
      validation.exchanges[1]!.response.receivedBytesSha256,
    );
    const v = verifyWatchEvidence(dir);
    expect(v.rederivation).toMatchObject({
      status: "REPRODUCED",
      rederivedOutcome: validation.outcome,
    });
    expect(v.completeness.reasons).toEqual([
      "PARTIAL_OR_UNREAD_BODY:2:PARTIAL_OVERFLOW",
      `OUTCOME:${validation.outcome}`,
    ]);
    expect(v).toMatchObject({ verified: true, selectionConfirmed: false });
    // The stricter supplied limit is part of the sealed policy context.
    expect(
      readJson(dir, WATCH_EVIDENCE_FILES.context).resolvedLimits.dexscreenerMaxResponseBytes,
    ).toBe(64);

    // A retained prefix that ends inside a credential: the trailing fragment is redacted too.
    const echo = await captureWatch();
    const raw = Buffer.from(`${"x".repeat(58)}${RPC_KEY} and more bytes after the cut`, "utf8");
    const cut = await validate(echo, makeMockFetch(echo.sched, { marketRawBody: raw }), { limits });
    const sealedCut = seal({
      watchResult: echo.watchResult,
      validation: cut,
      policyContext: { limits },
    });
    expect(sealedCut.result.ok).toBe(true);
    const cutMarket = readJson(sealedCut.dir, "exchanges/0002.json");
    expect(cut.exchanges[1]!.response.body).toBe(`${"x".repeat(58)}${RPC_KEY.slice(0, 6)}`);
    expect(cutMarket.response).toMatchObject({
      bodyState: "PARTIAL_OVERFLOW",
      bodyRedacted: true,
      reproducesReceivedDigest: false,
      body: `${"x".repeat(58)}[REDACTED_PARTIAL]`,
    });
    expect(cutMarket.response.receivedBytesSha256).toBe(sha256(raw.subarray(0, 64)));
    expect(cutMarket.response.sanitizedBytesSha256).toBe(
      sha256(Buffer.from(cutMarket.response.body, "utf8")),
    );
    const vc = verifyWatchEvidence(sealedCut.dir);
    expect(vc.completeness.reasons).toContain("BODY_REDACTED:2");
    // The incomplete body decides the outcome before redaction matters, so it still reproduces.
    expect(vc.rederivation).toMatchObject({ status: "REPRODUCED", rederivedOutcome: cut.outcome });
  });

  it("W-05: a write failure is explicit, never retried, never sealed, and keeps the run cause", async () => {
    const { env, validation, calls } = await selectedRun();
    const attempts: string[] = [];
    const failing: SealWatchEvidenceInput["writeEvidenceFile"] = (file, content, options) => {
      const rel = file.split(path.sep).slice(-2).join("/");
      attempts.push(rel);
      // Every evidence write is an exclusive create.
      expect(options).toEqual({ encoding: "utf8", flag: "wx" });
      if (rel === "exchanges/0002.json") {
        throw Object.assign(new Error(`EIO: device failure near ${RPC_URL}`), { code: "EIO" });
      }
      writeFileSync(file, content, options);
    };
    const { result, dir, projectRoot } = seal({
      watchResult: env.watchResult,
      validation,
      writeEvidenceFile: failing,
    });
    expect(result).toMatchObject({
      ok: false,
      status: "ARTIFACT_WRITE_FAILED",
      sealed: false,
      failedFile: "exchanges/0002.json",
      runCause: COMPLETED,
      recordedOutcome: "TARGET_SELECTED",
      filesWritten: ["plan.json", "context.json", "watch-observations.json", "exchanges/0001.json"],
    });
    expect(attempts.filter((a) => a === "exchanges/0002.json")).toHaveLength(1);
    expect(attempts.some((a) => a.endsWith(WATCH_EVIDENCE_FILES.manifest))).toBe(false);
    expect(JSON.stringify(result).includes(RPC_KEY)).toBe(false);
    expect(existsSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest))).toBe(false);
    expect(calls).toHaveLength(2); // no further acquisition

    const v = verifyWatchEvidence(dir);
    expect(v.integrity).toEqual({ ok: false, problems: ["MANIFEST_MISSING"] });
    expect(v.rederivation.status).toBe("NOT_ATTEMPTED");
    expect(v).toMatchObject({ verified: false, selectionConfirmed: false });
    // The partial directory is never reused or overwritten.
    const again = seal({ projectRoot, watchResult: env.watchResult, validation });
    expect(again.result).toMatchObject({ status: "OUTPUT_DIRECTORY_UNAVAILABLE" });
    expect(existsSync(path.join(dir, WATCH_EVIDENCE_FILES.manifest))).toBe(false);

    // Credentials must be supplied explicitly and are never echoed in a refusal.
    const missing = seal({ watchResult: env.watchResult, validation, credentials: {} });
    expect(missing.result).toMatchObject({ status: "SEAL_INPUT_INVALID" });
    const short = seal({
      watchResult: env.watchResult,
      validation,
      credentials: { ...CREDENTIALS, additional: ["abc12"] },
    });
    expect(short.result).toMatchObject({ status: "SEAL_INPUT_INVALID" });
    expect(JSON.stringify(short.result).includes("abc12")).toBe(false);
    expect(existsSync(missing.dir) || existsSync(short.dir)).toBe(false);
  });

  it("W-06: verification fails closed on corrupted references, outside paths, links, duplicates and extra files", async () => {
    const { env, validation } = await selectedRun();
    const { dir } = seal({ watchResult: env.watchResult, validation });
    expect(verifyWatchEvidence(dir).selectionConfirmed).toBe(true);
    let n = 0;
    const problemsAfter = (mutate: (d: string) => void): readonly string[] => {
      const d = copyRun(dir, `case-${++n}`);
      mutate(d);
      const v = verifyWatchEvidence(d);
      expect(v.integrity.ok).toBe(false);
      expect(v).toMatchObject({ verified: false, selectionConfirmed: false });
      expect(v.rederivation.status).toBe("NOT_ATTEMPTED");
      return v.integrity.problems;
    };
    const append = (d: string, rel: string, extra: string) =>
      writeFileSync(
        path.join(d, ...rel.split("/")),
        readFileSync(path.join(d, ...rel.split("/")), "utf8") + extra,
      );

    // Modified content.
    expect(problemsAfter((d) => append(d, WATCH_EVIDENCE_FILES.selection, " "))).toEqual([
      "SIZE_MISMATCH:selection.json",
    ]);
    expect(
      problemsAfter((d) => {
        const p = path.join(d, "exchanges", "0002.json");
        const t = readFileSync(p, "utf8");
        writeFileSync(p, t.replace("FRESH", "FRESX"));
      }),
    ).toEqual(["HASH_MISMATCH:exchanges/0002.json"]);
    // Extra files and directories at any depth.
    expect(problemsAfter((d) => writeFileSync(path.join(d, "extra.txt"), "x"))).toEqual([
      "UNLISTED_FILE:extra.txt",
    ]);
    expect(
      problemsAfter((d) => writeFileSync(path.join(d, "exchanges", "0003.json"), "{}")),
    ).toEqual(["UNLISTED_FILE:exchanges/0003.json"]);
    expect(
      problemsAfter((d) => {
        mkdirSync(path.join(d, "exchanges", "nested"));
        writeFileSync(path.join(d, "exchanges", "nested", "a.json"), "{}");
      }),
    ).toEqual(["UNLISTED_DIRECTORY:exchanges/nested", "UNLISTED_FILE:exchanges/nested/a.json"]);
    // Outside, absolute and traversal paths are rejected without being read.
    const outside = path.join(path.dirname(dir), "outside.json");
    writeFileSync(outside, "{}");
    for (const bad of [
      "../outside.json",
      outside,
      "exchanges\\0001.json",
      "./plan.json",
      "exchanges/../plan.json",
    ]) {
      const problems = problemsAfter((d) =>
        editManifest(d, (m) => {
          m.files.push({ path: bad, category: "EVIDENCE", sha256: sha256("{}"), bytes: 2 });
        }),
      );
      expect(problems).toEqual([`UNSAFE_PATH:${bad}`]);
    }
    // Duplicates (also by case), missing required entries, schema and version.
    expect(
      problemsAfter((d) =>
        editManifest(d, (m) => {
          m.files.push({ ...m.files[0] });
        }),
      ),
    ).toEqual(["DUPLICATE_ENTRY:plan.json"]);
    expect(
      problemsAfter((d) =>
        editManifest(d, (m) => {
          m.files.push({ ...m.files[0], path: "PLAN.json" });
        }),
      ),
    ).toEqual(["DUPLICATE_ENTRY:PLAN.json"]);
    expect(
      problemsAfter((d) => {
        editManifest(d, (m) => {
          m.files = m.files.filter((e: Loose) => e.path !== "context.json");
        });
        rmSync(path.join(d, "context.json"));
      }),
    ).toEqual(["REQUIRED_ENTRY_MISSING:context.json"]);
    expect(problemsAfter((d) => editManifest(d, (m) => void (m.version = 2)))).toEqual([
      "MANIFEST_VERSION_UNSUPPORTED",
    ]);
    expect(problemsAfter((d) => editManifest(d, (m) => void (m.kind = "OTHER")))).toEqual([
      "MANIFEST_KIND_INVALID",
    ]);
    // A malformed entry lists nothing: its file is then both unlisted and a missing requirement.
    expect(problemsAfter((d) => editManifest(d, (m) => void (m.files[0].extra = 1)))).toEqual([
      "MANIFEST_ENTRY_MALFORMED",
      "REQUIRED_ENTRY_MISSING:plan.json",
      "UNLISTED_FILE:plan.json",
    ]);
    expect(problemsAfter((d) => rmSync(path.join(d, WATCH_EVIDENCE_FILES.manifest)))).toEqual([
      "MANIFEST_MISSING",
    ]);
    expect(
      problemsAfter((d) => writeFileSync(path.join(d, WATCH_EVIDENCE_FILES.manifest), "{")),
    ).toEqual(["MANIFEST_NOT_JSON"]);
    // Links: a hard link to a listed file (works without privileges on NTFS and POSIX).
    expect(
      problemsAfter((d) =>
        linkSync(path.join(d, "plan.json"), path.join(path.dirname(d), `plan-link-${n}.json`)),
      ),
    ).toEqual(["LINK_REJECTED:plan.json"]);

    // Corrupted references with consistent hashes (re-forged), caught before responses are consumed.
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.requestExchanges]: (doc) => {
            doc.exchanges[0].file = "exchanges/0002.json";
          },
        }),
      ),
    ).toContain("EXCHANGE_INDEX_REFERENCE_INVALID:1");
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.requestExchanges]: (doc) => {
            doc.exchanges = doc.exchanges.slice(0, 1);
            doc.missingExchangeCount = 1;
          },
          [WATCH_EVIDENCE_FILES.requestLedger]: (doc) => {
            doc.entries = doc.entries.slice(0, 1);
          },
        }),
      ),
    ).toContain("UNINDEXED_RESPONSE:exchanges/0002.json");
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.report]: (doc) => {
            doc.files.plan = "other-plan.json";
          },
        }),
      ),
    ).toEqual(["REPORT_FILE_REFERENCES_INVALID"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.plan]: (doc) => {
            doc.mode = "CHANGED";
          },
        }),
      ),
    ).toEqual(["PLAN_DIGEST_MISMATCH:manifest", "PLAN_DIGEST_MISMATCH:report"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.requestLedger]: (doc) => {
            doc.entries[0].dispatchedAtMs += 1;
          },
        }),
      ),
    ).toEqual(["EXCHANGE_LEDGER_MISMATCH:1:dispatchedAtMs"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.requestLedger]: (doc) => {
            doc.entries[1].purpose = "PRECHECK_TRANSACTION";
          },
        }),
      ),
    ).toContain("LEDGER_INDEX_MISMATCH:2");
    expect(
      problemsAfter((d) =>
        reforge(d, {
          "exchanges/0002.json": (doc) => {
            doc.response.body = doc.response.body.replace("FRESH", "FRESX");
          },
        }),
      ),
    ).toEqual(["EXCHANGE_BODY_DIGEST_MISMATCH:2"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          "exchanges/0001.json": (doc) => {
            doc.request.headers = { authorization: "x" };
          },
        }),
      ),
    ).toEqual(["REQUEST_HEADERS_RECORDED:1"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.report]: (doc) => {
            doc.selected = false;
          },
        }),
      ),
    ).toEqual(["SELECTED_FLAG_INVALID"]);
    expect(
      problemsAfter((d) =>
        reforge(d, {
          [WATCH_EVIDENCE_FILES.report]: (doc) => {
            doc.terminalCause = {
              code: "WATCH_ENDED_WITHOUT_CAPTURE",
              stage: "WATCH",
              detail: null,
            };
          },
        }),
      ),
    ).toContain("TERMINAL_CAUSE:WATCH_CAUSE_INCONSISTENT");

    // The untouched original still verifies.
    expect(verifyWatchEvidence(dir)).toMatchObject({ verified: true, selectionConfirmed: true });
    expect(statSync(outside).size).toBe(2);
  });

  it("W-07: credential-bearing UTF-8 bodies, non-text bodies and frames are redacted before encoding; generic fields survive", async () => {
    // (a) UTF-8 market body echoing the key (plain and \u-escaped) next to a generic `token` field.
    const env = await captureWatch();
    const marketText = JSON.stringify({
      ...(marketResponse(START_MS - 300_000) as Record<string, unknown>),
      token: "SYNTHETIC-generic-token-field",
      echo: `request key ${RPC_KEY}`,
      escaped: "ESCAPED_PLACEHOLDER",
    }).replace("ESCAPED_PLACEHOLDER", `\\u0053${RPC_KEY.slice(1)}`);
    const live = await validate(
      env,
      makeMockFetch(env.sched, { marketRawBody: Buffer.from(marketText, "utf8") }),
    );
    expect(live.outcome).toBe("TARGET_SELECTED");
    const a = seal({ watchResult: env.watchResult, validation: live });
    expect(a.result).toMatchObject({
      ok: true,
      redaction: { applied: true, bodies: [2], reproducible: false },
    });
    expectNoSecrets(a.dir);
    const market = readJson(a.dir, "exchanges/0002.json");
    expect(market.response).toMatchObject({
      bodyEncoding: "utf8",
      bodyRedacted: true,
      reproducesReceivedDigest: false,
    });
    expect(market.response.receivedBytesSha256).toBe(sha256(Buffer.from(marketText, "utf8")));
    expect(market.response.sanitizedBytesSha256).not.toBe(market.response.receivedBytesSha256);
    const stored = JSON.parse(market.response.body) as Loose;
    expect(stored.token).toBe("SYNTHETIC-generic-token-field");
    expect(stored.echo).toBe("request key [REDACTED]");
    expect(stored.escaped).toBe("[REDACTED]");
    const report = readJson(a.dir, WATCH_EVIDENCE_FILES.report);
    expect(report.redaction.limitation).toMatch(/exact re-derivation is not possible/);
    const va = verifyWatchEvidence(a.dir);
    expect(va.integrity.ok).toBe(true);
    expect(va.rederivation).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      rederivedReason: "BODY_REDACTED",
    });
    expect(va.completeness.reasons).toEqual(["BODY_REDACTED:2"]);
    expect(va).toMatchObject({
      verified: true,
      selectionConfirmed: false,
      recordedOutcome: "TARGET_SELECTED",
    });

    // (b) Non-text RPC body carrying the key: redacted on bytes, stored as sanitized base64.
    const binEnv = await captureWatch();
    const rawRpc = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from(RPC_KEY, "utf8"),
      Buffer.from([0x80, 0x01]),
    ]);
    const bin = await validate(binEnv, makeMockFetch(binEnv.sched, { rpcRawBody: rawRpc }));
    expect(bin.exchanges[0]!.response.bodyEncoding).toBe("base64");
    const b = seal({ watchResult: binEnv.watchResult, validation: bin, terminalCause: COMPLETED });
    expect(b.result.ok).toBe(true);
    expectNoSecrets(b.dir);
    const rpc = readJson(b.dir, "exchanges/0001.json");
    expect(rpc.response).toMatchObject({
      bodyEncoding: "base64",
      bodyRedacted: true,
      reproducesReceivedDigest: false,
    });
    const decoded = Buffer.from(rpc.response.body, "base64");
    expect(
      decoded.equals(
        Buffer.concat([
          Buffer.from([0xff, 0xfe, 0x00]),
          Buffer.from("[REDACTED]"),
          Buffer.from([0x80, 0x01]),
        ]),
      ),
    ).toBe(true);
    expect(rpc.response.receivedBytesSha256).toBe(sha256(rawRpc));
    expect(rpc.response.sanitizedBytesSha256).toBe(sha256(decoded));
    const vb = verifyWatchEvidence(b.dir);
    expect(vb.integrity.ok).toBe(true);
    // A non-text body never qualifies, redacted or not, so the recorded rejection reproduces.
    expect(bin.outcome).not.toBe("TARGET_SELECTED");
    expect(vb.rederivation).toMatchObject({
      status: "REPRODUCED",
      rederivedOutcome: bin.outcome,
      rederivedReason: bin.reason,
    });
    expect(vb.completeness.reasons).toContain("BODY_REDACTED:1");
    expect(vb.selectionConfirmed).toBe(false);

    // (c) A watch frame echoing a credential: redacted before storage, original digest kept.
    const frameEnv = await captureWatch({
      script: [
        { atMs: 600, data: ACK },
        { atMs: 10_000, data: notificationFrame([`Program log: ${WSS_KEY}`]) },
      ],
    });
    expect(frameEnv.watchResult.status).toBe("NOTIFICATION_CAPTURED");
    const frameValidation = await validate(frameEnv, makeMockFetch(frameEnv.sched));
    const c = seal({ watchResult: frameEnv.watchResult, validation: frameValidation });
    expect(c.result.ok).toBe(true);
    expectNoSecrets(c.dir);
    const watch = readJson(c.dir, WATCH_EVIDENCE_FILES.watchObservations);
    const original = frameEnv.watchResult.observations.applicationFrames[2]!;
    expect(watch.frameRedactions).toEqual([
      expect.objectContaining({
        index: 2,
        originalSha256: sha256(original.payload as string),
        originalByteLength: original.byteLength,
      }),
    ]);
    expect(watch.watchResult.observations.applicationFrames[2].byteLength).toBe(
      original.byteLength,
    );
    expect(watch.watchResult.observations.applicationFrames[2].payload).toContain(
      "Program log: [REDACTED]",
    );
    const vc = verifyWatchEvidence(c.dir);
    expect(vc.rederivation.status).toBe("LIMITED_BY_REDACTION");
    expect(vc.completeness.reasons).toEqual(
      expect.arrayContaining(["FRAME_REDACTED:2", "LITERAL_REDACTION:watch-observations.json"]),
    );
    expect(vc).toMatchObject({ verified: true, selectionConfirmed: false });
  });
});
