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
  terminalCauseProblem,
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
    rpcHeaders?: Record<string, string>;
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
        { status: 200, headers: { "content-type": "application/json", ...o.rpcHeaders } },
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

const LIMIT_64 = Object.freeze({ dexscreenerMaxResponseBytes: 64 });

/** A market body cut at 64 bytes by the reviewed validator, sealed under the same limits. */
async function partialMarketRun(raw: Buffer) {
  const env = await captureWatch();
  const validation = await validate(env, makeMockFetch(env.sched, { marketRawBody: raw }), {
    limits: LIMIT_64,
  });
  const sealed = seal({
    watchResult: env.watchResult,
    validation,
    policyContext: { limits: LIMIT_64 },
  });
  return { validation, ...sealed };
}

/** A selected run whose market body echoes the RPC key (plain and escaped): it is redacted. */
async function redactedMarketRun() {
  const env = await captureWatch();
  const marketText = JSON.stringify({
    ...(marketResponse(START_MS - 300_000) as Record<string, unknown>),
    token: "SYNTHETIC-generic-token-field",
    echo: `request key ${RPC_KEY}`,
  });
  const validation = await validate(
    env,
    makeMockFetch(env.sched, { marketRawBody: Buffer.from(marketText, "utf8") }),
  );
  expect(validation.outcome).toBe("TARGET_SELECTED");
  return { validation, ...seal({ watchResult: env.watchResult, validation }) };
}

let forgeries = 0;
/** Verifies a re-forged copy (consistent hashes) and returns its verification. */
function verifyForged(dir: string, edits: Record<string, (doc: Loose) => void>) {
  const d = copyRun(dir, `forged-${++forgeries}`);
  reforge(d, edits);
  return verifyWatchEvidence(d);
}

/** Both copies of the recorded validation result (validation.json and selection.json). */
const editRecorded = (edit: (r: Loose) => void): Record<string, (doc: Loose) => void> => ({
  [WATCH_EVIDENCE_FILES.validation]: (doc) => edit(doc.result),
  [WATCH_EVIDENCE_FILES.selection]: (doc) => edit(doc),
});

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

  it("W-08: escaped and mixed credential fragments at the end of a partial body are redacted, also when cut inside an escape", async () => {
    const tail = " and more bytes after the cut";
    const cases = [
      // The review reproduction: an escaped first character, then literal characters.
      { raw: `${"x".repeat(50)}\\u0053${RPC_KEY.slice(1)}${tail}`, keep: 50 },
      // Mixed literal/escaped characters (upper-case hex), cut inside the next escape sequence.
      { raw: `${"x".repeat(52)}SY\\u004ETH\\u0045${RPC_KEY.slice(6)}${tail}`, keep: 52 },
      // Four literal characters, cut right after the backslash that starts an escape.
      { raw: `${"x".repeat(59)}SYNT\\u0048${RPC_KEY.slice(5)}${tail}`, keep: 59 },
      // Every character escaped (lower-case hex), cut inside the fifth escape.
      {
        raw: `${"x".repeat(37)}\\u0053\\u0059\\u004e\\u0054\\u0048${RPC_KEY.slice(5)}${tail}`,
        keep: 37,
      },
    ];
    for (const c of cases) {
      const raw = Buffer.from(c.raw, "utf8");
      const run = await partialMarketRun(raw);
      expect(run.result.ok).toBe(true);
      expect(run.validation.exchanges[1]!.response.body).toBe(c.raw.slice(0, 64));
      expectNoSecrets(run.dir);
      const market = readJson(run.dir, "exchanges/0002.json");
      const body = `${"x".repeat(c.keep)}[REDACTED_PARTIAL]`;
      expect(market.response).toMatchObject({
        bodyState: "PARTIAL_OVERFLOW",
        completeEvidence: false,
        retainedBytes: 64,
        maxResponseBytes: 64,
        receivedDigestScope: "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
        bodyEncoding: "utf8",
        storedBytes: Buffer.byteLength(body),
        bodyRedacted: true,
        reproducesReceivedDigest: false,
        body,
      });
      // The original-prefix digest is kept; the sanitized digest covers exactly the stored bytes.
      expect(market.response.receivedBytesSha256).toBe(sha256(raw.subarray(0, 64)));
      expect(market.response.sanitizedBytesSha256).toBe(sha256(Buffer.from(body, "utf8")));
      const report = readJson(run.dir, WATCH_EVIDENCE_FILES.report);
      expect(report.redaction).toMatchObject({ applied: true, bodies: [2], reproducible: false });
      const v = verifyWatchEvidence(run.dir);
      expect(v.integrity).toEqual({ ok: true, problems: [] });
      expect(v.completeness.reasons).toContain("BODY_REDACTED:2");
      // The overflow decides the outcome before the body is read, so it still reproduces.
      expect(v.rederivation).toMatchObject({
        status: "REPRODUCED",
        rederivedOutcome: run.validation.outcome,
      });
    }

    // Fewer than four credential characters before the cut stay below the fragment threshold.
    const short = `${"x".repeat(57)}SYN\\u0054${RPC_KEY.slice(4)}${tail}`;
    const below = await partialMarketRun(Buffer.from(short, "utf8"));
    expect(readJson(below.dir, "exchanges/0002.json").response).toMatchObject({
      body: short.slice(0, 64),
      bodyRedacted: false,
      reproducesReceivedDigest: true,
    });
  });

  it("W-09: exchange evidence is bound to the independently resolved limits and consistent body accounting", async () => {
    const { env, validation } = await selectedRun();
    // Both actual bodies are far larger than the 64-byte limits forged below.
    const bodies = validation.exchanges.map((e) => Number(e.response.retainedBytes));
    expect(bodies.every((n) => n > 64)).toBe(true);

    // (a) The review reproduction: limits far below the actual bodies are refused before writing.
    const tooSmall = seal({
      watchResult: env.watchResult,
      validation,
      policyContext: { limits: { rpcMaxResponseBytes: 64, dexscreenerMaxResponseBytes: 64 } },
    });
    expect(tooSmall.result).toMatchObject({ ok: false, status: "SEAL_INPUT_INVALID" });
    if (tooSmall.result.ok) throw new Error("unreachable");
    expect(tooSmall.result.reason).toContain("DECLARED_LIMIT_MISMATCH");
    expect(tooSmall.result.reason).toContain("RETAINED_EXCEEDS_LIMIT");
    expect(existsSync(tooSmall.dir)).toBe(false);

    // (b) Evidence acquired under a stricter limit cannot be sealed under the default context.
    const partial = await partialMarketRun(Buffer.from("y".repeat(200), "utf8"));
    expect(partial.result.ok).toBe(true);
    const env64 = await captureWatch();
    const v64 = await validate(
      env64,
      makeMockFetch(env64.sched, { marketRawBody: Buffer.from("y".repeat(200)) }),
      { limits: LIMIT_64 },
    );
    const defaultContext = seal({ watchResult: env64.watchResult, validation: v64 });
    expect(defaultContext.result).toMatchObject({
      status: "SEAL_INPUT_INVALID",
      reason: expect.stringContaining("exchange 2 body accounting"),
    });
    expect(existsSync(defaultContext.dir)).toBe(false);

    // (c) Contradictory supplied response metadata is refused before writing.
    const contradictory = (edit: (r: Loose) => void): WatchCandidateValidationResult => {
      const v = JSON.parse(JSON.stringify(validation)) as Loose;
      edit(v.exchanges[1].response);
      return v as WatchCandidateValidationResult;
    };
    for (const edit of [
      (r: Loose) => void (r.completeEvidence = false),
      (r: Loose) => void (r.receivedDigestScope = "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY"),
      (r: Loose) => void (r.maxResponseBytes = 1),
      (r: Loose) => void (r.observedBytes = 0),
      (r: Loose) => void (r.storedBytes += 1),
    ]) {
      const s = seal({ watchResult: env.watchResult, validation: contradictory(edit) });
      expect(s.result).toMatchObject({ status: "SEAL_INPUT_INVALID" });
      expect(existsSync(s.dir)).toBe(false);
    }

    // (d) Verification enforces the same accounting independently (re-forged, consistent hashes).
    const { dir } = seal({ watchResult: env.watchResult, validation });
    expect(verifyWatchEvidence(dir).selectionConfirmed).toBe(true);
    const problemsOf = (edits: Record<string, (doc: Loose) => void>) => {
      const v = verifyForged(dir, edits);
      expect(v).toMatchObject({ verified: false, selectionConfirmed: false });
      expect(v.rederivation.status).toBe("NOT_ATTEMPTED");
      return v.integrity.problems;
    };
    const market = (edit: (r: Loose) => void) => ({
      "exchanges/0002.json": (doc: Loose) => edit(doc.response),
    });
    // The review reproduction: all four contradictions at once.
    expect(
      problemsOf(
        market((r) => {
          r.completeEvidence = false;
          r.receivedDigestScope = "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY";
          r.maxResponseBytes = 1;
          r.observedBytes = 0;
        }),
      ),
    ).toEqual([
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:DECLARED_LIMIT_MISMATCH",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:COMPLETE_EVIDENCE_FLAG",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:OBSERVED_BYTES",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:DIGEST_SCOPE",
    ]);
    const single: [(r: Loose) => void, string[]][] = [
      [(r) => void (r.completeEvidence = false), ["COMPLETE_EVIDENCE_FLAG"]],
      [
        (r) => void (r.receivedDigestScope = "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY"),
        ["DIGEST_SCOPE"],
      ],
      [(r) => void (r.maxResponseBytes = 1), ["DECLARED_LIMIT_MISMATCH"]],
      [(r) => void (r.observedBytes = 0), ["OBSERVED_BYTES"]],
      [(r) => void (r.storedBytes += 1), ["STORED_BYTES"]],
      [(r) => void (r.retainedBytes += 1), ["OBSERVED_BYTES", "UNREDACTED_BODY_DIGEST"]],
      [(r) => void (r.reproducesReceivedDigest = false), ["UNREDACTED_BODY_DIGEST"]],
      [(r) => void (r.bodyEncoding = "base64"), ["BODY_UNDECODABLE"]],
    ];
    for (const [edit, names] of single) {
      const problems = problemsOf(market(edit));
      expect(problems).toEqual(
        names[0] === "BODY_UNDECODABLE"
          ? ["EXCHANGE_BODY_UNDECODABLE:2"]
          : names.map((n) => `EXCHANGE_BODY_ACCOUNTING_INVALID:2:${n}`),
      );
    }
    // A complete body recorded with an overflow error (ledger kept consistent).
    expect(
      problemsOf({
        "exchanges/0001.json": (doc) => void (doc.error = "RESPONSE_TOO_LARGE"),
        [WATCH_EVIDENCE_FILES.requestLedger]: (doc) =>
          void (doc.entries[0].error = "RESPONSE_TOO_LARGE"),
      }),
    ).toEqual(["EXCHANGE_BODY_ACCOUNTING_INVALID:1:COMPLETE_BODY_WITH_ERROR"]);

    // (e) Limits forged into the sealed context: the bodies exceed them, even when the declared
    //     limits are forged too; and the recorded resolved limits are only compared, never trusted.
    const forgedLimits = { rpcMaxResponseBytes: 64, dexscreenerMaxResponseBytes: 64 };
    const contextEdit = (doc: Loose) => {
      doc.suppliedContext.limits = forgedLimits;
      Object.assign(doc.resolvedLimits, forgedLimits);
    };
    expect(problemsOf({ [WATCH_EVIDENCE_FILES.context]: contextEdit })).toEqual([
      "EXCHANGE_BODY_ACCOUNTING_INVALID:1:DECLARED_LIMIT_MISMATCH",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:1:RETAINED_EXCEEDS_LIMIT",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:DECLARED_LIMIT_MISMATCH",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:RETAINED_EXCEEDS_LIMIT",
    ]);
    expect(
      problemsOf({
        [WATCH_EVIDENCE_FILES.context]: contextEdit,
        "exchanges/0001.json": (doc) => void (doc.response.maxResponseBytes = 64),
        "exchanges/0002.json": (doc) => void (doc.response.maxResponseBytes = 64),
      }),
    ).toEqual([
      "EXCHANGE_BODY_ACCOUNTING_INVALID:1:RETAINED_EXCEEDS_LIMIT",
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:RETAINED_EXCEEDS_LIMIT",
    ]);
    expect(
      problemsOf({
        [WATCH_EVIDENCE_FILES.context]: (doc) => void (doc.resolvedLimits.rpcMaxResponseBytes = 64),
      }),
    ).toEqual(["CONTEXT_RESOLVED_LIMITS_MISMATCH"]);
    expect(
      problemsOf({
        [WATCH_EVIDENCE_FILES.context]: (doc) => void (doc.recordedValidationDeadlineAtMs += 1),
      }),
    ).toEqual(["CONTEXT_DEADLINE_MISMATCH"]);

    // (f) A partial body must retain exactly the limit of a larger observed body.
    expect(verifyWatchEvidence(partial.dir).integrity.ok).toBe(true);
    const partialForged = verifyForged(partial.dir, {
      "exchanges/0002.json": (doc) => void (doc.response.observedBytes = 64),
    });
    expect(partialForged.integrity.problems).toEqual([
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:OBSERVED_BYTES",
    ]);
    const partialWithoutError = verifyForged(partial.dir, {
      "exchanges/0002.json": (doc) => void (doc.error = null),
      [WATCH_EVIDENCE_FILES.requestLedger]: (doc) => void (doc.entries[1].error = null),
    });
    expect(partialWithoutError.integrity.problems).toEqual([
      "EXCHANGE_BODY_ACCOUNTING_INVALID:2:PARTIAL_BODY_ERROR",
    ]);
  });

  it("W-10: redaction is a limitation only for the evidence it touched; independent contradictions stay MISMATCH", async () => {
    const run = await redactedMarketRun();
    const base = verifyWatchEvidence(run.dir);
    expect(base.rederivation).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      rederivedReason: "BODY_REDACTED",
    });
    expect(base).toMatchObject({ verified: true, selectionConfirmed: false });

    // (a) The review reproduction: the discovery slot +99, while the untouched frames derive the
    //     original slot. The market-body redaction cannot explain it.
    const slot = verifyForged(
      run.dir,
      editRecorded((r) => void (r.discovery.slot += 99)),
    );
    expect(slot.integrity.ok).toBe(true);
    expect(slot.rederivation.status).toBe("MISMATCH");
    expect(slot.rederivation.detail).toMatch(/fields redaction cannot change/);
    expect(slot).toMatchObject({ verified: false, selectionConfirmed: false });
    // Discovery strings come from unredacted frames: a body redaction cannot excuse them either.
    const logs = verifyForged(
      run.dir,
      editRecorded((r) => void (r.discovery.logs = ["Program log: forged"])),
    );
    expect(logs.rederivation.status).toBe("MISMATCH");
    expect(logs.rederivation.detail).toBe(
      "Re-derived discovery strings differ from the recorded discovery",
    );

    // (b) The transaction-derived target parts re-derive from the unredacted transaction body.
    const pool = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.poolId = "11111111111111111111111111111112")),
    );
    expect(pool.rederivation.status).toBe("MISMATCH");
    expect(pool).toMatchObject({ verified: false, selectionConfirmed: false });
    const block = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.initialization.transactionBlockTimeSec += 1)),
    );
    expect(block.rederivation.status).toBe("MISMATCH");
    const received = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.market.receivedAtMs += 1)),
    );
    expect(received.rederivation.status).toBe("MISMATCH");

    // (c) A recorded outcome that cannot follow the qualifying, unredacted transaction is not
    //     explained by the market-body redaction.
    const nonmatch = {
      recordedOutcome: "TRANSACTION_NONMATCH",
      runOutcome: "TRANSACTION_NONMATCH",
      reason: "DECODED_NONMATCH:NO_AMM_V4_INITIALIZE2",
    };
    const failed = verifyForged(run.dir, {
      [WATCH_EVIDENCE_FILES.validation]: (doc) =>
        void Object.assign(doc.result, {
          ok: false,
          outcome: nonmatch.recordedOutcome,
          reason: nonmatch.reason,
          target: null,
        }),
      [WATCH_EVIDENCE_FILES.selection]: (doc) =>
        void Object.assign(doc, { ...nonmatch, selected: false, target: null }),
      [WATCH_EVIDENCE_FILES.report]: (doc) =>
        void Object.assign(doc, {
          recordedOutcome: nonmatch.recordedOutcome,
          runOutcome: nonmatch.runOutcome,
          selected: false,
        }),
    });
    expect(failed.integrity.ok).toBe(true);
    expect(failed.rederivation.status).toBe("MISMATCH");
    expect(failed.verified).toBe(false);

    // (d) The deadline depends only on numbers and the policy context: never a redaction limit.
    const deadline = verifyForged(run.dir, {
      [WATCH_EVIDENCE_FILES.validation]: (doc) => void (doc.result.validationDeadlineAtMs -= 1),
      [WATCH_EVIDENCE_FILES.context]: (doc) => {
        doc.recordedValidationDeadlineAtMs -= 1;
        doc.recomputedValidationDeadlineAtMs -= 1;
      },
    });
    expect(deadline.rederivation).toMatchObject({
      status: "MISMATCH",
      detail: "Re-derived validation deadline differs from the recorded deadline",
    });

    // (e) Values that only the redacted market body determines remain a stated limitation.
    const indicator = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.market.informationalIndicators.liquidityUsd += 1)),
    );
    expect(indicator.rederivation.status).toBe("LIMITED_BY_REDACTION");
    expect(indicator).toMatchObject({ verified: true, selectionConfirmed: false });

    // (f) Redacted frames: the recorded discovery's numbers must agree with the sealed watch
    //     metadata, and the unredacted exchanges are still checked against the recorded result.
    const frameEnv = await captureWatch({
      script: [
        { atMs: 600, data: ACK },
        { atMs: 10_000, data: notificationFrame([`Program log: ${WSS_KEY}`]) },
      ],
    });
    const frameValidation = await validate(frameEnv, makeMockFetch(frameEnv.sched));
    const frames = seal({ watchResult: frameEnv.watchResult, validation: frameValidation });
    expect(verifyWatchEvidence(frames.dir).rederivation.status).toBe("LIMITED_BY_REDACTION");
    const frameSlot = verifyForged(
      frames.dir,
      editRecorded((r) => void (r.discovery.slot += 99)),
    );
    expect(frameSlot.rederivation.status).toBe("MISMATCH");
    expect(frameSlot.rederivation.detail).toMatch(/contradict the sealed watch metadata/);
    const framePool = verifyForged(
      frames.dir,
      editRecorded((r) => void (r.target.poolId = "11111111111111111111111111111112")),
    );
    expect(framePool.rederivation.status).toBe("MISMATCH");
    expect(framePool).toMatchObject({ verified: false, selectionConfirmed: false });

    // (g) A redaction claim cannot be invented to unlock the limitation.
    const { env, validation } = await selectedRun();
    const clean = seal({ watchResult: env.watchResult, validation });
    const claimed = verifyForged(clean.dir, {
      [WATCH_EVIDENCE_FILES.report]: (doc) =>
        void (doc.redaction.literalByFile[WATCH_EVIDENCE_FILES.validation] = 1),
    });
    expect(claimed.integrity.problems).toEqual([
      "REDACTION_CLAIM_UNSUPPORTED:validation.json",
      "REDACTION_CLAIM_MISMATCH:flags",
    ]);
  });

  it("W-11: exchange-record redaction excuses only differences in fields the derivation reads", async () => {
    // The review reproduction: the RPC key in the transaction response's allowlisted retry-after
    // header, sealed normally. Both bodies stay unredacted.
    const env = await captureWatch();
    const validation = await validate(
      env,
      makeMockFetch(env.sched, { rpcHeaders: { "retry-after": RPC_KEY } }),
    );
    expect(validation.outcome).toBe("TARGET_SELECTED");
    const run = seal({ watchResult: env.watchResult, validation });
    expect(run.result.ok).toBe(true);
    expectNoSecrets(run.dir);
    const txFile = readJson(run.dir, "exchanges/0001.json");
    expect(txFile.response.headers["retry-after"]).toBe("[REDACTED]");
    expect(txFile.response.bodyRedacted).toBe(false);
    expect(readJson(run.dir, "exchanges/0002.json").response.bodyRedacted).toBe(false);
    const report = readJson(run.dir, WATCH_EVIDENCE_FILES.report);
    expect(report.redaction.literalByFile["exchanges/0001.json"]).toBe(1);
    expect(report.redaction.bodies).toEqual([]);

    // (a) Genuine, unchanged target: the derivation reads no header, so it re-derives exactly;
    //     the conservative selection restriction still withholds confirmation.
    const genuine = verifyWatchEvidence(run.dir);
    expect(genuine.integrity.ok).toBe(true);
    expect(genuine.rederivation).toMatchObject({
      status: "REPRODUCED",
      recordedOutcome: "TARGET_SELECTED",
      rederivedOutcome: "TARGET_SELECTED",
    });
    expect(genuine.completeness.reasons).toContain("LITERAL_REDACTION:exchanges/0001.json");
    expect(genuine).toMatchObject({ verified: true, selectionConfirmed: false });

    // (b) The review reproduction: a forged pool address. The unredacted transaction body proves
    //     the original pool; a redacted header cannot explain the change.
    const pool = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.poolId = "11111111111111111111111111111112")),
    );
    expect(pool.integrity.ok).toBe(true);
    expect(pool.rederivation.status).toBe("MISMATCH");
    expect(pool.rederivation.detail).toMatch(/consumed no redacted evidence/);
    expect(pool).toMatchObject({ verified: false, selectionConfirmed: false });
    const block = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.initialization.transactionBlockTimeSec += 1)),
    );
    expect(block.rederivation.status).toBe("MISMATCH");
    const indicator = verifyForged(
      run.dir,
      editRecorded((r) => void (r.target.market.informationalIndicators.liquidityUsd += 1)),
    );
    expect(indicator.rederivation.status).toBe("MISMATCH");
    expect(indicator.verified).toBe(false);

    // (c) A redacted field the derivation does read (the market request URL) is a limitation,
    //     while every fact the unredacted transaction derives is still checked.
    const marketUrlRedacted = {
      "exchanges/0002.json": (doc: Loose) =>
        void (doc.request.url = String(doc.request.url).replace(
          String(validation.target!.mintAddress),
          "[REDACTED]",
        )),
      [WATCH_EVIDENCE_FILES.report]: (doc: Loose) =>
        void (doc.redaction.literalByFile["exchanges/0002.json"] = 1),
    };
    const urlLimited = verifyForged(run.dir, marketUrlRedacted);
    expect(urlLimited.integrity.ok).toBe(true);
    expect(urlLimited.rederivation).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      rederivedReason: "MARKET_REQUEST_NOT_FOR_DECODED_MINT",
    });
    expect(urlLimited.rederivation.detail).toMatch(/exchange 2: request\.url/);
    expect(urlLimited).toMatchObject({ verified: true, selectionConfirmed: false });
    const urlPool = verifyForged(run.dir, {
      ...marketUrlRedacted,
      ...editRecorded((r) => void (r.target.poolId = "11111111111111111111111111111112")),
    });
    expect(urlPool.rederivation.status).toBe("MISMATCH");
    expect(urlPool.rederivation.detail).toMatch(/unredacted transaction evidence/);
    expect(urlPool).toMatchObject({ verified: false, selectionConfirmed: false });
    const nonmatch = {
      recordedOutcome: "TRANSACTION_NONMATCH",
      runOutcome: "TRANSACTION_NONMATCH",
      reason: "DECODED_NONMATCH:NO_AMM_V4_INITIALIZE2",
    };
    const urlStage = verifyForged(run.dir, {
      ...marketUrlRedacted,
      [WATCH_EVIDENCE_FILES.validation]: (doc) =>
        void Object.assign(doc.result, {
          ok: false,
          outcome: nonmatch.recordedOutcome,
          reason: nonmatch.reason,
          target: null,
        }),
      [WATCH_EVIDENCE_FILES.selection]: (doc) =>
        void Object.assign(doc, { ...nonmatch, selected: false, target: null }),
      [WATCH_EVIDENCE_FILES.report]: (doc) => {
        marketUrlRedacted[WATCH_EVIDENCE_FILES.report](doc);
        Object.assign(doc, {
          recordedOutcome: nonmatch.recordedOutcome,
          runOutcome: nonmatch.runOutcome,
          selected: false,
        });
      },
    });
    expect(urlStage.integrity.ok).toBe(true);
    expect(urlStage.rederivation.status).toBe("MISMATCH");
    expect(urlStage.rederivation.detail).toMatch(/stops at the transaction stage/);
    // Both bodies are unredacted, so the whole target re-derives with the URL at its qualifying
    // value: even a market-derived value cannot be changed under a redacted request URL.
    const urlIndicator = verifyForged(run.dir, {
      ...marketUrlRedacted,
      ...editRecorded((r) => void (r.target.market.informationalIndicators.liquidityUsd += 1)),
    });
    expect(urlIndicator.rederivation.status).toBe("MISMATCH");
    expect(urlIndicator.rederivation.detail).toMatch(/at their qualifying values/);

    // (d) A redacted transaction request field the decode reads (the requested signature): the
    //     unredacted transaction body still proves the initialization.
    const paramRedacted = {
      "exchanges/0001.json": (doc: Loose) => void (doc.request.rpcParams[0] = "[REDACTED]"),
      [WATCH_EVIDENCE_FILES.report]: (doc: Loose) =>
        void (doc.redaction.literalByFile["exchanges/0001.json"] = 2),
    };
    const paramLimited = verifyForged(run.dir, paramRedacted);
    expect(paramLimited.integrity.ok).toBe(true);
    expect(paramLimited.rederivation).toMatchObject({
      status: "LIMITED_BY_REDACTION",
      rederivedReason: "TRANSACTION_REQUEST_IDENTITY_INVALID",
    });
    expect(paramLimited.rederivation.detail).toMatch(/exchange 1: request\.rpcParams/);
    expect(paramLimited).toMatchObject({ verified: true, selectionConfirmed: false });
    const paramPool = verifyForged(run.dir, {
      ...paramRedacted,
      ...editRecorded((r) => void (r.target.poolId = "11111111111111111111111111111112")),
    });
    expect(paramPool.rederivation.status).toBe("MISMATCH");
    expect(paramPool).toMatchObject({ verified: false, selectionConfirmed: false });
    // A redacted string that cannot hold the qualifying value ("0" is not base58) means the
    // original request could not have qualified either.
    const paramImpossible = verifyForged(run.dir, {
      ...paramRedacted,
      "exchanges/0001.json": (doc: Loose) => void (doc.request.rpcParams[0] = "0[REDACTED]"),
    });
    expect(paramImpossible.rederivation.status).toBe("MISMATCH");
    // Markers without a literal-redaction claim for that file are not redaction at all.
    const unclaimed = verifyForged(run.dir, {
      "exchanges/0002.json": marketUrlRedacted["exchanges/0002.json"],
    });
    expect(unclaimed.integrity.ok).toBe(true);
    expect(unclaimed.rederivation.status).toBe("MISMATCH");
    // A redacted JSON-RPC id is a string, but the sealed body answers a numeric id: the original
    // request could not have qualified, so a recorded target is a contradiction.
    const idRedacted = verifyForged(run.dir, {
      "exchanges/0001.json": (doc: Loose) => void (doc.jsonRpcId = "[REDACTED]"),
      [WATCH_EVIDENCE_FILES.report]: (doc: Loose) =>
        void (doc.redaction.literalByFile["exchanges/0001.json"] = 2),
    });
    expect(idRedacted.integrity.ok).toBe(true);
    expect(idRedacted.rederivation.status).toBe("MISMATCH");
    expect(idRedacted.rederivation.detail).toMatch(/does not qualify/);
  });
  it("W-12: cancellation after a completed validation is sealed at RUN, keeps the evidence and is never confirmed", async () => {
    const cancelledRun: WatchRunTerminalCause = {
      code: "OPERATOR_CANCELLED",
      stage: "RUN",
      detail: "Operator cancellation after validation finished, before sealing",
    };
    // The minimal extension: RUN-stage cancellation after capture, with or without a finished
    // validation; every other combination stays inconsistent.
    const captured = "NOTIFICATION_CAPTURED";
    expect(terminalCauseProblem(cancelledRun, captured, "TARGET_SELECTED")).toBeNull();
    expect(terminalCauseProblem(cancelledRun, captured, "MARKET_NONMATCH")).toBeNull();
    expect(terminalCauseProblem(cancelledRun, captured, null)).toBeNull();
    expect(terminalCauseProblem(cancelledRun, captured, "OPERATOR_CANCELLED")).toBe(
      "CANCELLATION_CAUSE_INCONSISTENT",
    );
    expect(terminalCauseProblem(cancelledRun, "NO_QUALIFYING_NOTIFICATION_OBSERVED", null)).toBe(
      "CANCELLATION_CAUSE_INCONSISTENT",
    );
    expect(terminalCauseProblem(cancelledRun, "OPERATOR_CANCELLED", null)).toBe(
      "CANCELLATION_CAUSE_INCONSISTENT",
    );
    expect(
      terminalCauseProblem({ ...cancelledRun, stage: "WATCH" }, captured, "TARGET_SELECTED"),
    ).toBe("CANCELLATION_CAUSE_INCONSISTENT");
    expect(
      terminalCauseProblem({ ...cancelledRun, stage: "VALIDATION" }, captured, "TARGET_SELECTED"),
    ).toBe("CANCELLATION_CAUSE_INCONSISTENT");
    expect(terminalCauseProblem(COMPLETED, captured, "OPERATOR_CANCELLED")).toBe(
      "CANCELLATION_NOT_PRESERVED",
    );

    // A completed, selected validation sealed under a RUN-stage cancellation.
    const { env, validation } = await selectedRun();
    const { result, dir } = seal({
      watchResult: env.watchResult,
      validation,
      terminalCause: cancelledRun,
    });
    expect(result).toMatchObject({
      ok: true,
      runCause: cancelledRun,
      recordedOutcome: "TARGET_SELECTED",
    });
    expect(readJson(dir, WATCH_EVIDENCE_FILES.selection)).toMatchObject({
      selected: false,
      recordedOutcome: "TARGET_SELECTED",
      runOutcome: "OPERATOR_CANCELLED",
      terminalCause: cancelledRun,
    });
    // The usable completed evidence is retained unchanged...
    expect(readJson(dir, WATCH_EVIDENCE_FILES.validation).result).toMatchObject({
      outcome: "TARGET_SELECTED",
      target: validation.target,
    });
    expect(readJson(dir, "exchanges/0001.json").purpose).toBe("PRECHECK_TRANSACTION");
    expect(readJson(dir, "exchanges/0002.json").purpose).toBe("PRECHECK_MARKET");
    // ...re-derives exactly, and is still never confirmed or released.
    const v = verifyWatchEvidence(dir);
    expect(v).toMatchObject({
      integrity: { ok: true, problems: [] },
      completeness: {
        sufficientForSelection: false,
        reasons: ["TERMINAL_CAUSE:OPERATOR_CANCELLED"],
      },
      rederivation: { status: "REPRODUCED" },
      runOutcome: "OPERATOR_CANCELLED",
      recordedOutcome: "TARGET_SELECTED",
      verified: true,
      selectionConfirmed: false,
      confirmedTarget: null,
    });
    expect(v.terminalCause).toEqual(cancelledRun);

    // Strict consistency is retained at sealing: a cancelled validation keeps its own stage.
    const cancelledValidation: WatchCandidateValidationResult = {
      ...validation,
      ok: false,
      outcome: "OPERATOR_CANCELLED",
      reason: "OPERATOR_CANCELLED: INTERRUPTED_AFTER_RESPONSE",
      target: null,
    };
    const wrongStage = seal({
      watchResult: env.watchResult,
      validation: cancelledValidation,
      terminalCause: cancelledRun,
    });
    expect(wrongStage.result).toMatchObject({
      ok: false,
      status: "SEAL_INPUT_INVALID",
      reason: expect.stringContaining("CANCELLATION_CAUSE_INCONSISTENT"),
    });
    expect(existsSync(wrongStage.dir)).toBe(false);

    // Relabelling the sealed cancellation as completion (consistent hashes) is caught by the
    // selection and report consistency checks unless every copy is forged.
    const relabelled = copyRun(dir, "cancelled-relabelled");
    reforge(relabelled, {
      [WATCH_EVIDENCE_FILES.selection]: (doc) => {
        doc.selected = true;
      },
    });
    const vr = verifyWatchEvidence(relabelled);
    expect(vr.integrity.ok).toBe(false);
    expect(vr).toMatchObject({ selectionConfirmed: false, confirmedTarget: null });
  });
});
