/**
 * Conditional handoff (offline): code/configuration pin, evidence integrity, re-derivation of the
 * sealed target, the start window on the runner's age source, and the pilot output directory.
 * SYNTHETIC precheck evidence and a fake git runner; no network. The watched-evidence handoff uses
 * GENUINE collector output on a scripted in-memory transport, the reviewed validator against a
 * scripted fetch, and evidence sealed into this test's own temporary directories.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER,
  INHERITED_RUNTIME_CONFIGURATION,
  PIN_PATHS,
  RUNNER_DEPENDENCY_PATHS,
  REVIEWED_RUNNER_COMMIT,
  REVIEWED_ENDPOINT_MODIFICATIONS,
  checkPin,
  defaultGit,
  evaluatePilotHandoff,
  evaluateWatchedPilotHandoff,
  HANDOFF_EXIT_CODES,
  loadVerifiedExchanges,
  runHandoffCli,
  type GitRunner,
} from "./paper-pilot-handoff.js";
import {
  MATCH_PAIR_CREATED_AT_MS,
  MINT,
  NOW_SEC,
  POOL,
  START_MS,
  TEST_RPC_URL,
  VirtualScheduler,
  drive,
  initTransactionResult,
  key,
  marketResponse,
  precheckEnv,
  sig,
  standardScenario,
} from "./fresh-amm-v4-precheck.test-support.js";
import { PRECHECK_ROOT_SEGMENTS } from "./fresh-amm-v4-precheck.js";
import {
  WATCH_EVIDENCE_FILES,
  sealWatchEvidence,
  verifyWatchEvidence,
  type WatchEvidenceVerification,
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

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const PINNED = "a".repeat(40);
const PRECHECK = "data/research/prechecks/handoff";
const PILOT = "data/research/single-candidate/pilot-01-test";
const RUNNER_OPEN_SEC = Math.floor(MATCH_PAIR_CREATED_AT_MS / 1000);
const atAge = (ageSec: number) => (RUNNER_OPEN_SEC + ageSec) * 1000;

type GitAnswer = { status: number; stdout: string };
/**
 * Fake git. Path-aware options answer only when the queried pathspec includes the path, so a
 * refusal proves the path is part of the pin: changed (differs from the pinned commit), dirty
 * (modified in the working tree) or changedSinceRunner (modified since the reviewed runner).
 */
function fakeGit(
  o: Partial<Record<"revParse" | "diffQuiet" | "status" | "nameStatus" | "lsTree", GitAnswer>> & {
    readonly changed?: readonly string[];
    readonly dirty?: readonly string[];
    readonly changedSinceRunner?: readonly string[];
    readonly onCall?: () => void;
  } = {},
) {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    o.onCall?.();
    const queried = (p: string) => args.includes(p);
    if (args[0] === "rev-parse") return o.revParse ?? { status: 0, stdout: PINNED };
    if (args[0] === "diff" && args[1] === "--quiet") {
      if (o.changed?.some(queried)) return { status: 1, stdout: "" };
      return o.diffQuiet ?? { status: 0, stdout: "" };
    }
    if (args[0] === "status") {
      const dirty = (o.dirty ?? []).filter(queried);
      if (dirty.length > 0) return { status: 0, stdout: dirty.map((p) => ` M ${p}`).join("\n") };
      return o.status ?? { status: 0, stdout: "" };
    }
    if (args[0] === "diff" && args[1] === "--name-status" && o.changedSinceRunner) {
      return {
        status: 0,
        stdout: o.changedSinceRunner
          .filter(queried)
          .map((p) => `M\t${p}`)
          .join("\n"),
      };
    }
    if (args[0] === "diff" && args[1] === "--name-status") {
      return (
        o.nameStatus ?? {
          status: 0,
          stdout: ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER.map((f) => `A\t${f}`).join("\n"),
        }
      );
    }
    if (args[0] === "ls-tree") {
      return (
        o.lsTree ?? {
          status: 0,
          stdout: Object.entries(REVIEWED_ENDPOINT_MODIFICATIONS)
            .map(([file, e]) => `${e.mode} ${e.type} ${e.oid}\t${file}`)
            .join("\n"),
        }
      );
    }
    return { status: 1, stdout: "" };
  };
  return { git, calls };
}

async function sealedPrecheck(scenario = standardScenario()) {
  const env = precheckEnv(scenario);
  roots.push(env.projectRoot);
  const r = await env.run("handoff");
  return { root: env.projectRoot, dir: r.outDir!, selection: r.selection! };
}

const evaluate = (
  root: string,
  nowMs: number,
  git: GitRunner = fakeGit().git,
  pilot = PILOT,
  precheck = PRECHECK,
) =>
  evaluatePilotHandoff({
    projectRoot: root,
    precheckDir: precheck,
    pilotOutDir: pilot,
    pinnedCommit: PINNED,
    clock: () => nowMs,
    git,
  });

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Parsed JSON from sealed files (shape checked by the assertions). */
type Loose = ReturnType<typeof JSON.parse>;

/** Rewrites one sealed file and its manifest entry consistently (integrity then still passes). */
function rewriteSealed(dir: string, rel: string, content: string) {
  writeFileSync(path.join(dir, rel), content);
  const manifestPath = path.join(dir, "evidence-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((f: { path: string }) => f.path === rel);
  entry.sha256 = sha256(content);
  entry.bytes = Buffer.byteLength(content);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

describe("Stage A -> Stage B conditional handoff (offline)", () => {
  it("H-01: allows exactly the sealed identity inside the window, answers one bounded WAIT before it, and refuses after it", async () => {
    const { root } = await sealedPrecheck();
    const { git, calls } = fakeGit();
    const allowed = evaluate(root, atAge(300), git);
    expect(allowed).toMatchObject({
      decision: "ALLOWED",
      refusals: [],
      poolId: POOL,
      mintAddress: MINT,
      ageSecNow: 300,
      ageSource: "DEXSCREENER_PAIR_CREATED_AT",
      pilotOutDir: PILOT,
      startWindow: { status: expect.stringMatching(/^PLANNING_ESTIMATE/) },
    });
    // The pin compares the relevant paths with the pinned commit and the runner's surface with 6855efb.
    expect(
      calls.some(
        (c) => c[0] === "diff" && c[1] === "--quiet" && PIN_PATHS.every((p) => c.includes(p)),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.includes(REVIEWED_RUNNER_COMMIT) && c.includes(PINNED))).toBe(true);

    const wait = evaluate(root, NOW_SEC * 1000);
    expect(wait).toMatchObject({
      decision: "WAIT",
      refusals: ["START_WINDOW_NOT_YET_OPEN"],
      poolId: POOL,
    });
    expect(wait.waitMs).toBe(atAge(240) - NOW_SEC * 1000);
    expect(evaluate(root, atAge(761))).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
    });
    expect(evaluate(root, atAge(-10))).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_TOO_FAR_AHEAD"],
    });
    expect(evaluate(root, atAge(760)).decision).toBe("ALLOWED");
    expect(evaluate(root, atAge(240)).decision).toBe("ALLOWED");
  });

  it("H-02: refuses changed, dirty or diverged code and configuration", async () => {
    const { root } = await sealedPrecheck();
    const now = atAge(300);
    const cases: [string, GitRunner, string][] = [
      [
        "unknown commit",
        fakeGit({ revParse: { status: 1, stdout: "" } }).git,
        "PINNED_COMMIT_UNKNOWN",
      ],
      [
        "changed",
        fakeGit({ diffQuiet: { status: 1, stdout: "" } }).git,
        "CODE_OR_CONFIGURATION_CHANGED",
      ],
      [
        "modified",
        fakeGit({ status: { status: 0, stdout: " M backend/src/x.ts\n" } }).git,
        "RELEVANT_FILES_DIRTY",
      ],
      [
        "untracked",
        fakeGit({ status: { status: 0, stdout: "?? backend/src/scripts/new.ts\n" } }).git,
        "RELEVANT_FILES_DIRTY",
      ],
      [
        "runner dependency modified",
        fakeGit({
          nameStatus: {
            status: 0,
            stdout: "M\tbackend/src/candidate-scanner/PaperRequestSession.ts",
          },
        }).git,
        "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/candidate-scanner/PaperRequestSession.ts",
      ],
      [
        "unexpected addition",
        fakeGit({ nameStatus: { status: 0, stdout: "A\tbackend/src/scripts/other.ts" } }).git,
        "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/other.ts",
      ],
      [
        "allowed file deleted",
        fakeGit({
          nameStatus: { status: 0, stdout: `D\t${ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER[0]}` },
        }).git,
        `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER[0]}`,
      ],
    ];
    for (const [label, git, refusal] of cases) {
      const r = evaluate(root, now, git);
      expect(r.decision, label).toBe("REFUSED");
      expect(r.refusals, label).toContain(refusal);
      expect(r.poolId, label).toBeUndefined(); // no identity is released
    }
    expect(checkPin("not-a-commit", fakeGit().git)).toEqual(["PINNED_COMMIT_INVALID"]);
  });

  it("H-03: refuses invalid or unreproducible evidence, a precheck without a target, and an unusable pilot directory", async () => {
    const { root, dir } = await sealedPrecheck();
    const now = atAge(300);
    const copy = (name: string) => {
      const target = path.join(root, "data/research/prechecks", name);
      cpSync(dir, target, { recursive: true });
      return { abs: target, rel: `data/research/prechecks/${name}` };
    };

    const tampered = copy("tampered");
    writeFileSync(path.join(tampered.abs, "selection.json"), "{}");
    expect(evaluate(root, now, undefined, PILOT, tampered.rel).refusals).toContain(
      "INVALID_EVIDENCE:MODIFIED:selection.json",
    );

    const extra = copy("extra");
    writeFileSync(path.join(extra.abs, "exchanges", "9999.json"), "{}");
    expect(evaluate(root, now, undefined, PILOT, extra.rel).refusals).toContain(
      "INVALID_EVIDENCE:UNLISTED:exchanges/9999.json",
    );

    // A substituted identity with a consistently rewritten manifest is not reproducible.
    const substituted = copy("substituted");
    const selection = readFileSync(path.join(substituted.abs, "selection.json"), "utf8");
    rewriteSealed(
      substituted.abs,
      "selection.json",
      selection.split(POOL).join(key("substituted-pool")),
    );
    expect(evaluate(root, now, undefined, PILOT, substituted.rel).refusals).toEqual([
      "SELECTION_NOT_REPRODUCIBLE_FROM_SEALED_RESPONSES",
    ]);

    // A sealed response edited to point elsewhere no longer reproduces the sealed selection.
    const edited = copy("edited-response");
    const tx = readFileSync(path.join(edited.abs, "exchanges", "0003.json"), "utf8");
    rewriteSealed(edited.abs, "exchanges/0003.json", tx.split(sig(104)).join(sig(777)));
    expect(evaluate(root, now, undefined, PILOT, edited.rel).decision).toBe("REFUSED");

    expect(
      evaluate(root, now, undefined, PILOT, "data/research/prechecks/missing").refusals,
    ).toEqual(["PRECHECK_EVIDENCE_MISSING"]);

    mkdirSync(path.join(root, PILOT), { recursive: true });
    expect(evaluate(root, now).refusals).toEqual(["PILOT_OUTPUT_EXISTS"]);
    expect(evaluate(root, now, undefined, "data/research/diagnostics/pilot").refusals).toEqual([
      "PILOT_OUTPUT_INVALID",
    ]);

    const none = await sealedPrecheck(
      standardScenario({
        transactions: [
          {
            signature: sig(103),
            slot: 998,
            blockTime: NOW_SEC - 60,
            feeDestination: key("not-the-fee-account"),
          },
          {
            signature: sig(104),
            slot: 997,
            blockTime: NOW_SEC - 120,
            feeDestination: key("not-the-fee-account"),
          },
        ],
      }),
    );
    expect(evaluate(none.root, now).refusals).toEqual([
      "PRECHECK_NO_TARGET:SAMPLE_PRODUCED_NO_SUITABLE_TARGET",
    ]);
  });
});

describe("Handoff corrections (review of 6515fcb)", () => {
  it("H-04: the clock is read after validation; crossing the closing boundary during validation refuses", async () => {
    const { root } = await sealedPrecheck();
    // Invoked at age 759 s; the git checks take long enough to reach 763 s.
    let now = atAge(759);
    const { git } = fakeGit({
      onCall: () => {
        now = atAge(763);
      },
    });
    const r = evaluatePilotHandoff({
      projectRoot: root,
      precheckDir: PRECHECK,
      pilotOutDir: PILOT,
      pinnedCommit: PINNED,
      clock: () => now,
      git,
    });
    expect(r).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
      ageSecNow: 763,
    });
    expect(r.evaluatedAtIso).toBe(new Date(atAge(763)).toISOString());

    // The same applies to the opening boundary: validation ending inside the window allows.
    let early = atAge(239);
    const opening = fakeGit({
      onCall: () => {
        early = atAge(241);
      },
    });
    expect(
      evaluatePilotHandoff({
        projectRoot: root,
        precheckDir: PRECHECK,
        pilotOutDir: PILOT,
        pinnedCommit: PINNED,
        clock: () => early,
        git: opening.git,
      }),
    ).toMatchObject({ decision: "ALLOWED", ageSecNow: 241 });
  });

  it("H-05: every response reference is validated before any is read; outside files are never consumed", async () => {
    const { root, dir } = await sealedPrecheck();
    const now = atAge(300);
    const copy = (name: string) => {
      const abs = path.join(root, "data/research/prechecks", name);
      cpSync(dir, abs, { recursive: true });
      return { abs, rel: `data/research/prechecks/${name}` };
    };
    const editIndex = (abs: string, edit: (index: Loose) => void) => {
      const index = JSON.parse(readFileSync(path.join(abs, "request-exchanges.json"), "utf8"));
      edit(index);
      rewriteSealed(abs, "request-exchanges.json", JSON.stringify(index));
    };

    // The reviewer's reproduction: the signature exchange points outside the seal at an identical
    // response, with the index's manifest digest updated.
    for (const [name, content] of [
      ["outside-identical", readFileSync(path.join(dir, "exchanges", "0001.json"), "utf8")],
      ["outside-unreadable", "NOT JSON: reading this would fail differently"],
    ] as const) {
      const c = copy(name);
      writeFileSync(path.join(root, "outside-signatures.json"), content);
      editIndex(c.abs, (index) => {
        index.exchanges[0].file = "../../../../outside-signatures.json";
      });
      const r = evaluate(root, now, undefined, PILOT, c.rel);
      // Refused on the reference itself: the outside file was never read (an unreadable file
      // would otherwise have produced INVALID_EVIDENCE:UNREADABLE).
      expect(r.refusals, name).toContain("INVALID_EXCHANGE_REFERENCE:#0:PATH");
      expect(
        r.refusals.some((x) => x.includes("UNREADABLE")),
        name,
      ).toBe(false);
      expect(r.poolId, name).toBeUndefined();
    }

    const cases: [string, (abs: string) => void, string][] = [
      [
        "absolute",
        (abs) =>
          editIndex(abs, (i) => (i.exchanges[1].file = path.join(abs, "exchanges", "0002.json"))),
        "INVALID_EXCHANGE_REFERENCE:#1:PATH",
      ],
      [
        "duplicate",
        (abs) => editIndex(abs, (i) => i.exchanges.push({ ...i.exchanges[0] })),
        `INVALID_EXCHANGE_REFERENCE:#${4}:DUPLICATE`,
      ],
      [
        "unindexed response",
        (abs) => editIndex(abs, (i) => i.exchanges.pop()),
        "INVALID_EXCHANGE_REFERENCE:UNINDEXED:exchanges/0004.json",
      ],
      [
        "missing exchanges",
        (abs) => editIndex(abs, (i) => (i.missingExchangeSeqs = [5])),
        "EVIDENCE_INCOMPLETE:MISSING_EXCHANGES",
      ],
      [
        "capture failures",
        (abs) => editIndex(abs, (i) => (i.captureFailures = ["SYNTHETIC write failure"])),
        "EVIDENCE_INCOMPLETE:CAPTURE_FAILURES",
      ],
      [
        "ledger accounting",
        (abs) => {
          const l = JSON.parse(readFileSync(path.join(abs, "request-ledger.json"), "utf8"));
          l.httpAttempts = 5;
          rewriteSealed(abs, "request-ledger.json", JSON.stringify(l));
        },
        "LEDGER_MISMATCH:ACCOUNTING",
      ],
      [
        "ledger disagreement",
        (abs) => {
          const l = JSON.parse(readFileSync(path.join(abs, "request-ledger.json"), "utf8"));
          l.ledger[1].httpStatus = 500;
          rewriteSealed(abs, "request-ledger.json", JSON.stringify(l));
        },
        "LEDGER_MISMATCH:EXCHANGE_2",
      ],
    ];
    for (const [label, mutate, refusal] of cases) {
      const c = copy(label.replace(/ /g, "-"));
      mutate(c.abs);
      const r = evaluate(root, now, undefined, PILOT, c.rel);
      expect(r.decision, label).toBe("REFUSED");
      expect(r.refusals, label).toContain(refusal);
    }
    // The untouched seal still loads and allows.
    expect(loadVerifiedExchanges(dir)).toMatchObject({ ok: true });
    expect(evaluate(root, now).decision).toBe("ALLOWED");
  });

  it("H-06: inherited root runtime configuration is pinned; the secret environment file is not inspected", async () => {
    const { root } = await sealedPrecheck();
    const now = atAge(300);
    expect([...INHERITED_RUNTIME_CONFIGURATION]).toEqual([
      "tsconfig.base.json",
      ".npmrc",
      ".node-version",
      ".nvmrc",
    ]);
    for (const p of INHERITED_RUNTIME_CONFIGURATION) {
      expect(PIN_PATHS).toContain(p);
      expect(RUNNER_DEPENDENCY_PATHS).toContain(p);
    }
    expect(PIN_PATHS.some((p) => p.includes(".env"))).toBe(false);
    for (const p of INHERITED_RUNTIME_CONFIGURATION) {
      expect(evaluate(root, now, fakeGit({ changed: [p] }).git).refusals, p).toContain(
        "CODE_OR_CONFIGURATION_CHANGED",
      );
      expect(evaluate(root, now, fakeGit({ dirty: [p] }).git).refusals, p).toContain(
        "RELEVANT_FILES_DIRTY",
      );
      expect(evaluate(root, now, fakeGit({ changedSinceRunner: [p] }).git).refusals, p).toContain(
        `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${p}`,
      );
    }
    // No git call ever names the environment file, and refusals carry codes, not file contents.
    const { git, calls } = fakeGit({ dirty: ["tsconfig.base.json"] });
    const r = evaluate(root, now, git);
    expect(calls.flat().some((a) => a.includes(".env"))).toBe(false);
    expect(r.refusals).toEqual(["RELEVANT_FILES_DIRTY"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Watched-evidence handoff: SYNTHETIC collector + validator harness (as in the reviewed
// watch-evidence tests), sealed into this test's own temporary project roots.
// ---------------------------------------------------------------------------------------------

const WATCH_SIG =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const WATCH_NOTIFY_AT = START_MS + 10_000;
const WATCH_RPC_KEY = "SYNTHETIC-secret-key-123";
const WATCH_RPC_URL = `${TEST_RPC_URL}/?key=${WATCH_RPC_KEY}`;
const WATCH_CREDENTIALS = Object.freeze({
  rpcUrl: WATCH_RPC_URL,
  wssUrl: "wss://synthetic.invalid/watch?api-key=SYNTHETIC-wss-key-456789",
});
const WATCH_PLAN = Object.freeze({ kind: "SYNTHETIC_WATCH_RUN_PLAN", mode: "OFFLINE_TEST" });
const WATCH_PAIR_CREATED_AT_MS = START_MS - 300_000;
const WATCH_OPEN_SEC = Math.floor(WATCH_PAIR_CREATED_AT_MS / 1000);
const watchAge = (ageSec: number) => (WATCH_OPEN_SEC + ageSec) * 1000;
const WATCH_COMPLETED: WatchRunTerminalCause = {
  code: "COMPLETED",
  stage: "VALIDATION",
  detail: null,
};

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

const WATCH_ACK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 });
const WATCH_NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "logsNotification",
  params: {
    subscription: 42,
    result: {
      context: { slot: 250_000 },
      value: { err: null, signature: WATCH_SIG, logs: ["Program log: initialize2"] },
    },
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
    { atMs: 600, data: WATCH_ACK },
    { atMs: 10_000, data: WATCH_NOTIFICATION },
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
type WatchEnv = Awaited<ReturnType<typeof captureWatch>>;

/** Mocked validation requests (no network): the RPC transaction, then the market pairs. */
function mockFetch(
  sched: VirtualScheduler,
  o: { marketRawBody?: Buffer; rpcHeaders?: Record<string, string> } = {},
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
    await delay(init?.signal);
    if (url.startsWith(TEST_RPC_URL)) {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: initTransactionResult({
            signature: WATCH_SIG,
            slot: 250_000,
            blockTime: Math.floor(START_MS / 1000) - 300,
            openTime: Math.floor(START_MS / 1000) - 290,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json", ...o.rpcHeaders } },
      );
    }
    if (o.marketRawBody) return new Response(new Uint8Array(o.marketRawBody), { status: 200 });
    return new Response(JSON.stringify(marketResponse(WATCH_PAIR_CREATED_AT_MS)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function validateWatch(
  env: WatchEnv,
  fetchFn: typeof fetch,
  extra: { abortSignal?: AbortSignal; limits?: WatchEvidenceContext["limits"] } = {},
): Promise<WatchCandidateValidationResult> {
  return drive(
    env.sched,
    executeWatchCandidateValidation({
      watchResult: env.watchResult,
      rpcUrl: WATCH_RPC_URL,
      clock: () => env.sched.now,
      timers: env.timers,
      fetchFn,
      ...extra,
    }),
  );
}

/** A fresh temporary project root (removed after each test). */
function watchRoot(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), "handoff-watch-test-"));
  roots.push(r);
  return r;
}

const watchRel = (runName: string) => [...PRECHECK_ROOT_SEGMENTS, runName].join("/");

/** Seals one run into `root` and returns its relative directory. */
function sealRun(
  root: string,
  runName: string,
  over: {
    watchResult: WatchEnv["watchResult"];
    validation?: WatchCandidateValidationResult | null;
    terminalCause?: WatchRunTerminalCause;
    policyContext?: WatchEvidenceContext;
  },
): string {
  const r = sealWatchEvidence({
    projectRoot: root,
    runName,
    plan: WATCH_PLAN,
    validation: over.validation ?? null,
    terminalCause: over.terminalCause ?? WATCH_COMPLETED,
    credentials: WATCH_CREDENTIALS,
    clock: () => START_MS + 60_000,
    watchResult: over.watchResult,
    ...(over.policyContext ? { policyContext: over.policyContext } : {}),
  });
  expect(r.ok, runName).toBe(true);
  return watchRel(runName);
}

async function selectedWatch() {
  const env = await captureWatch();
  const validation = await validateWatch(env, mockFetch(env.sched));
  expect(validation.outcome).toBe("TARGET_SELECTED");
  return { env, validation };
}

/** Re-forges sealed JSON documents with consistent manifest entries (integrity still passes). */
function reforgeWatch(dir: string, edits: Record<string, (doc: Loose) => void>): void {
  const manifestPath = path.join(dir, WATCH_EVIDENCE_FILES.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [rel, edit] of Object.entries(edits)) {
    const file = path.join(dir, ...rel.split("/"));
    const doc = JSON.parse(readFileSync(file, "utf8"));
    edit(doc);
    const content = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(file, content);
    const entry = (manifest.files as Loose[]).find((e) => e.path === rel);
    if (entry) {
      entry.sha256 = sha256(content);
      entry.bytes = Buffer.byteLength(content);
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function copyWatch(root: string, rel: string, name: string): string {
  cpSync(path.join(root, ...rel.split("/")), path.join(root, ...watchRel(name).split("/")), {
    recursive: true,
  });
  return watchRel(name);
}

const OTHER_POOL = "11111111111111111111111111111112";

const watched = (
  root: string,
  evidence: string,
  nowMs: number,
  o: { git?: GitRunner; pilot?: string; verify?: (dir: string) => WatchEvidenceVerification } = {},
) =>
  evaluateWatchedPilotHandoff({
    projectRoot: root,
    watchEvidenceDir: evidence,
    pilotOutDir: o.pilot ?? PILOT,
    pinnedCommit: PINNED,
    clock: () => nowMs,
    git: o.git ?? fakeGit().git,
    ...(o.verify ? { verify: o.verify } : {}),
  });

describe("Watched-evidence handoff (offline integration)", () => {
  it("H-07: a confirmed watched selection is handed off with the verified identity; WAIT and expiry boundaries", async () => {
    const root = watchRoot();
    const { env, validation } = await selectedWatch();
    const run = sealRun(root, "watch-selected", { watchResult: env.watchResult, validation });
    const v = verifyWatchEvidence(path.join(root, ...run.split("/")));
    expect(v).toMatchObject({ selectionConfirmed: true, rederivation: { status: "REPRODUCED" } });
    expect(v.confirmedTarget).toEqual(validation.target);
    expect(Object.isFrozen(v.confirmedTarget)).toBe(true);
    expect(Object.isFrozen(v.confirmedTarget?.market)).toBe(true);
    expect(validation.target?.market.runnerOpenTimeSec).toBe(WATCH_OPEN_SEC);

    const { git, calls } = fakeGit();
    expect(watched(root, run, watchAge(300), { git })).toMatchObject({
      decision: "ALLOWED",
      refusals: [],
      poolId: POOL,
      mintAddress: MINT,
      ageSecNow: 300,
      ageSource: "DEXSCREENER_PAIR_CREATED_AT",
      pilotOutDir: PILOT,
      evidenceSource: "WATCH_EVIDENCE",
      startWindow: { status: expect.stringMatching(/^PLANNING_ESTIMATE/) },
    });
    expect(
      calls.some(
        (c) => c[0] === "diff" && c[1] === "--quiet" && PIN_PATHS.every((p) => c.includes(p)),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.includes(REVIEWED_RUNNER_COMMIT) && c.includes(PINNED))).toBe(true);

    // Window boundaries on the runner's age source (240-760 s), one bounded WAIT at most.
    expect(watched(root, run, watchAge(240)).decision).toBe("ALLOWED");
    expect(watched(root, run, watchAge(760)).decision).toBe("ALLOWED");
    expect(watched(root, run, watchAge(760) + 999).decision).toBe("ALLOWED");
    expect(watched(root, run, watchAge(761))).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
      ageSecNow: 761,
      poolId: POOL,
    });
    const wait = watched(root, run, watchAge(239));
    expect(wait).toMatchObject({ decision: "WAIT", refusals: ["START_WINDOW_NOT_YET_OPEN"] });
    expect(wait.waitMs).toBe(1000);
    const longest = watched(root, run, watchAge(0));
    expect(longest).toMatchObject({ decision: "WAIT", waitMs: 240_000 });
    expect(watched(root, run, watchAge(0) - 1)).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_TOO_FAR_AHEAD"],
    });
  });

  it("H-08: the clock is read after verification; crossing either boundary during verification decides on the later time", async () => {
    const root = watchRoot();
    const { env, validation } = await selectedWatch();
    const run = sealRun(root, "watch-timing", { watchResult: env.watchResult, validation });

    let now = watchAge(759);
    let clockReadsDuringVerification = 0;
    let verifying = false;
    const slowVerify = (dir: string) => {
      verifying = true;
      const v = verifyWatchEvidence(dir);
      verifying = false;
      now = watchAge(763); // verification took four seconds
      return v;
    };
    const r = evaluateWatchedPilotHandoff({
      projectRoot: root,
      watchEvidenceDir: run,
      pilotOutDir: PILOT,
      pinnedCommit: PINNED,
      clock: () => {
        if (verifying) clockReadsDuringVerification++;
        return now;
      },
      git: fakeGit().git,
      verify: slowVerify,
    });
    expect(r).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
      ageSecNow: 763,
    });
    expect(r.evaluatedAtIso).toBe(new Date(watchAge(763)).toISOString());
    expect(clockReadsDuringVerification).toBe(0);

    let early = watchAge(239);
    expect(
      evaluateWatchedPilotHandoff({
        projectRoot: root,
        watchEvidenceDir: run,
        pilotOutDir: PILOT,
        pinnedCommit: PINNED,
        clock: () => early,
        git: fakeGit().git,
        verify: (dir) => {
          const v = verifyWatchEvidence(dir);
          early = watchAge(241);
          return v;
        },
      }),
    ).toMatchObject({ decision: "ALLOWED", ageSecNow: 241 });
  });

  it("H-09: every non-confirmed watched outcome refuses without releasing an identity", async () => {
    const root = watchRoot();
    const now = watchAge(300);
    const { env, validation } = await selectedWatch();
    const runs: [string, string, string[]][] = [];

    // A watch without capture, and operator cancellation during the watch.
    const quiet = await captureWatch({
      script: [{ atMs: 600, data: WATCH_ACK }],
      limits: { watchCeilingMs: 20_000 },
    });
    runs.push([
      "watch ended without capture",
      sealRun(root, "no-capture", {
        watchResult: quiet.watchResult,
        terminalCause: { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH", detail: null },
      }),
      [
        "WATCH_EVIDENCE_INCOMPLETE:VALIDATION_NOT_RECORDED",
        "WATCH_SELECTION_NOT_ELIGIBLE",
        "WATCH_SELECTION_NOT_CONFIRMED",
      ],
    ]);
    const cancelledWatch = await captureWatch({
      script: [{ atMs: 600, data: WATCH_ACK }],
      abortAtMs: 5_000,
    });
    runs.push([
      "cancelled during the watch",
      sealRun(root, "cancelled-watch", {
        watchResult: cancelledWatch.watchResult,
        terminalCause: { code: "OPERATOR_CANCELLED", stage: "WATCH", detail: "operator stop" },
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:TERMINAL_CAUSE:OPERATOR_CANCELLED"],
    ]);

    // Operator cancellation while the transaction request is in flight.
    const inflight = await captureWatch();
    const controller = new AbortController();
    inflight.sched.at(WATCH_NOTIFY_AT + 50, () => controller.abort());
    const cancelled = await validateWatch(inflight, mockFetch(inflight.sched), {
      abortSignal: controller.signal,
    });
    expect(cancelled.outcome).toBe("OPERATOR_CANCELLED");
    runs.push([
      "cancelled during validation",
      sealRun(root, "cancelled-validation", {
        watchResult: inflight.watchResult,
        validation: cancelled,
        terminalCause: { code: "OPERATOR_CANCELLED", stage: "VALIDATION", detail: null },
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:OUTCOME:OPERATOR_CANCELLED", "WATCH_SELECTION_NOT_ELIGIBLE"],
    ]);

    // A run failure after a selected validation: the validation reproduces, the run does not count.
    runs.push([
      "run failure",
      sealRun(root, "run-failed", {
        watchResult: env.watchResult,
        validation,
        terminalCause: { code: "RUN_FAILED", stage: "RUN", detail: "synthetic failure" },
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:TERMINAL_CAUSE:RUN_FAILED", "WATCH_SELECTION_NOT_CONFIRMED"],
    ]);

    // Partial market evidence (64-byte limit): no selection.
    const limited = { dexscreenerMaxResponseBytes: 64 };
    const partialEnv = await captureWatch();
    const partial = await validateWatch(partialEnv, mockFetch(partialEnv.sched), {
      limits: limited,
    });
    expect(partial.outcome).not.toBe("TARGET_SELECTED");
    runs.push([
      "partial market body",
      sealRun(root, "partial-market", {
        watchResult: partialEnv.watchResult,
        validation: partial,
        policyContext: { limits: limited },
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:PARTIAL_OR_UNREAD_BODY:2:PARTIAL_OVERFLOW"],
    ]);

    // A redacted market body: LIMITED_BY_REDACTION.
    const redactedEnv = await captureWatch();
    const marketText = JSON.stringify({
      ...(marketResponse(WATCH_PAIR_CREATED_AT_MS) as Record<string, unknown>),
      echo: `request key ${WATCH_RPC_KEY}`,
    });
    const redacted = await validateWatch(
      redactedEnv,
      mockFetch(redactedEnv.sched, { marketRawBody: Buffer.from(marketText, "utf8") }),
    );
    expect(redacted.outcome).toBe("TARGET_SELECTED");
    runs.push([
      "redacted market body",
      sealRun(root, "redacted-market", {
        watchResult: redactedEnv.watchResult,
        validation: redacted,
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:BODY_REDACTED:2", "WATCH_SELECTION_LIMITED_BY_REDACTION"],
    ]);

    // Header-only redaction re-derives exactly but keeps the conservative restriction.
    const headerEnv = await captureWatch();
    const header = await validateWatch(
      headerEnv,
      mockFetch(headerEnv.sched, { rpcHeaders: { "retry-after": WATCH_RPC_KEY } }),
    );
    runs.push([
      "redacted response header",
      sealRun(root, "redacted-header", { watchResult: headerEnv.watchResult, validation: header }),
      [
        "WATCH_EVIDENCE_INCOMPLETE:LITERAL_REDACTION:exchanges/0001.json",
        "WATCH_SELECTION_NOT_CONFIRMED",
      ],
    ]);

    // A mismatch: the recorded pool forged in both copies with consistent hashes.
    const selected = sealRun(root, "selected", { watchResult: env.watchResult, validation });
    const forged = copyWatch(root, selected, "forged-pool");
    reforgeWatch(path.join(root, ...forged.split("/")), {
      [WATCH_EVIDENCE_FILES.validation]: (doc) => void (doc.result.target.poolId = OTHER_POOL),
      [WATCH_EVIDENCE_FILES.selection]: (doc) => void (doc.target.poolId = OTHER_POOL),
    });
    runs.push(["forged pool", forged, ["WATCH_SELECTION_MISMATCH"]]);

    // Cancellation observed after a completed, selected validation (sealed at RUN): the usable
    // evidence is retained and re-derives exactly, but continuation is not authorized.
    runs.push([
      "cancelled after a completed validation",
      sealRun(root, "cancelled-after-validation", {
        watchResult: env.watchResult,
        validation,
        terminalCause: {
          code: "OPERATOR_CANCELLED",
          stage: "RUN",
          detail: "Operator cancellation after validation finished, before sealing",
        },
      }),
      ["WATCH_EVIDENCE_INCOMPLETE:TERMINAL_CAUSE:OPERATOR_CANCELLED"],
    ]);

    for (const [label, rel, expected] of runs) {
      const r = watched(root, rel, now);
      expect(r.decision, label).toBe("REFUSED");
      for (const e of expected) expect(r.refusals, label).toContain(e);
      expect(r.refusals, label).toContain("WATCH_SELECTION_NOT_CONFIRMED");
      expect(r.poolId, label).toBeUndefined();
      expect(r.mintAddress, label).toBeUndefined();
      expect(r.evidenceSource, label).toBe("WATCH_EVIDENCE");
      // The verifier itself exposes no target unless the selection is confirmed.
      expect(verifyWatchEvidence(path.join(root, ...rel.split("/"))).confirmedTarget, label).toBe(
        null,
      );
    }
    // The untouched selected run is still handed off.
    expect(watched(root, selected, now).decision).toBe("ALLOWED");
  });

  it("H-10: altered, missing or misplaced evidence refuses; the target comes only from the verified snapshot", async () => {
    const root = watchRoot();
    const now = watchAge(300);
    const { env, validation } = await selectedWatch();
    const selected = sealRun(root, "selected", { watchResult: env.watchResult, validation });
    const abs = (rel: string) => path.join(root, ...rel.split("/"));

    // selection.json alone re-forged to another pool: the copies disagree (integrity).
    const selectionOnly = copyWatch(root, selected, "selection-only");
    reforgeWatch(abs(selectionOnly), {
      [WATCH_EVIDENCE_FILES.selection]: (doc) => void (doc.target.poolId = OTHER_POOL),
    });
    const s1 = watched(root, selectionOnly, now);
    expect(s1.decision).toBe("REFUSED");
    expect(s1.refusals.every((r) => r.startsWith("INVALID_EVIDENCE:"))).toBe(true);
    expect(s1.poolId).toBeUndefined();

    // A sealed byte changed without the manifest.
    const tampered = copyWatch(root, selected, "tampered");
    const txFile = path.join(abs(tampered), "exchanges", "0001.json");
    writeFileSync(txFile, readFileSync(txFile, "utf8").replace(POOL, OTHER_POOL));
    expect(
      watched(root, tampered, now).refusals.some((r) => r.startsWith("INVALID_EVIDENCE:")),
    ).toBe(true);

    // A sealed response re-forged consistently: the selection no longer reproduces.
    const response = copyWatch(root, selected, "response-forged");
    reforgeWatch(abs(response), {
      "exchanges/0002.json": (doc) => void (doc.request.url = String(doc.request.url) + "x"),
    });
    expect(watched(root, response, now).decision).toBe("REFUSED");

    // Missing, outside or root-level evidence, and precheck evidence (no format guessing).
    expect(watched(root, watchRel("missing"), now).refusals).toEqual(["WATCH_EVIDENCE_MISSING"]);
    for (const outside of [
      "data/research/single-candidate/watch",
      PRECHECK_ROOT_SEGMENTS.join("/"),
      "../elsewhere",
      path.join(os.tmpdir(), "watch"),
    ]) {
      expect(watched(root, outside, now).refusals, outside).toEqual([
        "WATCH_EVIDENCE_LOCATION_INVALID",
      ]);
    }
    const precheck = await sealedPrecheck();
    const asWatch = watched(precheck.root, PRECHECK, atAge(300));
    expect(asWatch.decision).toBe("REFUSED");
    expect(asWatch.refusals.every((r) => r.startsWith("INVALID_EVIDENCE:"))).toBe(true);
    // ...and the precheck handoff does not accept watch evidence either.
    expect(evaluate(root, now, undefined, PILOT, selected).decision).toBe("REFUSED");

    // The verified snapshot's target is used: changing the files after verification (consistently
    // re-forged) cannot redirect the handoff, because nothing is reopened.
    const snapshot = copyWatch(root, selected, "snapshot");
    const r = watched(root, snapshot, now, {
      verify: (dir) => {
        const v = verifyWatchEvidence(dir);
        reforgeWatch(dir, {
          [WATCH_EVIDENCE_FILES.validation]: (doc) => void (doc.result.target.poolId = OTHER_POOL),
          [WATCH_EVIDENCE_FILES.selection]: (doc) => void (doc.target.poolId = OTHER_POOL),
        });
        return v;
      },
    });
    expect(r).toMatchObject({ decision: "ALLOWED", poolId: POOL, mintAddress: MINT });
    expect(verifyWatchEvidence(abs(snapshot)).selectionConfirmed).toBe(false);

    // A verification without a confirmed target never releases one, whatever else it claims.
    const v = verifyWatchEvidence(abs(selected));
    const claims: [string, WatchEvidenceVerification][] = [
      ["unconfirmed", { ...v, selectionConfirmed: false }],
      ["no target", { ...v, confirmedTarget: null }],
      ["not verified", { ...v, verified: false }],
      ["limited", { ...v, rederivation: { ...v.rederivation, status: "LIMITED_BY_REDACTION" } }],
      ["incomplete", { ...v, completeness: { sufficientForSelection: false, reasons: ["X"] } }],
    ];
    for (const [label, claim] of claims) {
      const c = watched(root, selected, now, { verify: () => claim });
      expect(c.decision, label).toBe("REFUSED");
      expect(c.poolId, label).toBeUndefined();
    }
    // A confirmed target with a non-canonical identity or orientation is refused.
    const target = v.confirmedTarget!;
    const identities: [string, Loose][] = [
      ["pool = mint", { ...target, poolId: target.mintAddress }],
      ["non-canonical pool", { ...target, poolId: "0OIl" }],
      ["WSOL candidate", { ...target, mintAddress: target.quoteMint }],
      ["orientation", { ...target, orientation: "WSOL_BASE_CANDIDATE_QUOTE" }],
    ];
    for (const [label, t] of identities) {
      expect(
        watched(root, selected, now, { verify: () => ({ ...v, confirmedTarget: t }) }).refusals,
        label,
      ).toEqual(["TARGET_IDENTITY_INVALID"]);
    }
    expect(
      watched(root, selected, now, {
        verify: () => ({
          ...v,
          confirmedTarget: { ...target, market: { ...target.market, runnerOpenTimeSec: 1.5 } },
        }),
      }).refusals,
    ).toEqual(["START_WINDOW_SOURCE_INVALID"]);
  });

  it("H-11: pin failures and invalid or existing output directories refuse the watched handoff", async () => {
    const root = watchRoot();
    const now = watchAge(300);
    const { env, validation } = await selectedWatch();
    const selected = sealRun(root, "selected", { watchResult: env.watchResult, validation });
    let verifications = 0;
    const counting = (dir: string) => {
      verifications++;
      return verifyWatchEvidence(dir);
    };

    const pinCases: [string, GitRunner, string][] = [
      [
        "unknown commit",
        fakeGit({ revParse: { status: 1, stdout: "" } }).git,
        "PINNED_COMMIT_UNKNOWN",
      ],
      [
        "changed",
        fakeGit({ diffQuiet: { status: 1, stdout: "" } }).git,
        "CODE_OR_CONFIGURATION_CHANGED",
      ],
      ["dirty", fakeGit({ dirty: ["backend"] }).git, "RELEVANT_FILES_DIRTY"],
      [
        "runner dependency modified",
        fakeGit({ changedSinceRunner: ["backend"] }).git,
        "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend",
      ],
    ];
    for (const [label, git, refusal] of pinCases) {
      const r = watched(root, selected, now, { git, verify: counting });
      expect(r.decision, label).toBe("REFUSED");
      expect(r.refusals, label).toContain(refusal);
      expect(r.poolId, label).toBeUndefined();
    }
    expect(verifications).toBe(0); // the pin is checked before any evidence is read

    expect(
      watched(root, selected, now, { pilot: "data/research/diagnostics/pilot" }).refusals,
    ).toEqual(["PILOT_OUTPUT_INVALID"]);
    expect(
      watched(root, selected, now, { pilot: "data/research/single-candidate" }).refusals,
    ).toEqual(["PILOT_OUTPUT_INVALID"]);
    expect(watched(root, selected, now, { pilot: "../pilot" }).refusals).toEqual([
      "PILOT_OUTPUT_INVALID",
    ]);
    mkdirSync(path.join(root, PILOT), { recursive: true });
    expect(watched(root, selected, now).refusals).toEqual(["PILOT_OUTPUT_EXISTS"]);
  });

  it("H-12: the pin allows exactly the reviewed additions since the runner", () => {
    const added = [
      "backend/src/candidate-scanner/BoundedAmmV4CreationWatch.ts",
      "backend/src/candidate-scanner/BoundedAmmV4CreationWatch.test.ts",
      "backend/src/candidate-scanner/AmmV4WatchCandidateValidation.ts",
      "backend/src/candidate-scanner/AmmV4WatchCandidateValidation.test.ts",
      "backend/src/scripts/fresh-amm-v4-watch-evidence.ts",
      "backend/src/scripts/fresh-amm-v4-watch-evidence.test.ts",
      "backend/src/scripts/fresh-amm-v4-watch.ts",
      "backend/src/scripts/fresh-amm-v4-watch.test.ts",
      "backend/src/scripts/paper-pilot-sequence.test.ts",
      "backend/src/scripts/solana-subscription-capability.ts",
      "backend/src/scripts/solana-subscription-capability.test.ts",
      "backend/src/scripts/amm-v4-watch-retrospective.ts",
      "backend/src/scripts/amm-v4-watch-retrospective.test.ts",
      "backend/src/candidate-scanner/RaydiumCpmmPoolStateAdapter.ts",
      "backend/src/candidate-scanner/RaydiumCpmmPoolStateAdapter.test.ts",
      "backend/src/candidate-scanner/DexScreenerCpmmCandidateMarketParser.ts",
      "backend/src/candidate-scanner/DexScreenerCpmmCandidateMarketParser.test.ts",
      "backend/src/candidate-scanner/RaydiumCpmmSwapDecoder.ts",
      "backend/src/candidate-scanner/RaydiumCpmmSwapDecoder.test.ts",
      "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapter.ts",
      "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapter.test.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.test.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationCollector.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationCollector.test.ts",
      "backend/src/candidate-scanner/CpmmPoolConnectionOwner.ts",
      "backend/src/candidate-scanner/CpmmPoolConnectionOwner.test.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransport.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransport.test.ts",
      "backend/src/scripts/evidence-credential-sanitizer.ts",
      "backend/src/scripts/evidence-credential-sanitizer.test.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorder.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorder.test.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence.test.ts",
      "backend/src/candidate-scanner/CpmmPoolAccountAcquisition.ts",
      "backend/src/candidate-scanner/CpmmPoolAccountAcquisition.test.ts",
    ];
    // The wrapper and its sequence core are pinned (compared with the pinned commit, clean).
    expect(PIN_PATHS).toContain("scripts/paper-pilot-sequence.ps1");
    expect(PIN_PATHS).toContain("scripts/paper-pilot-sequence.core.ps1");
    expect(PIN_PATHS.filter((p) => p.startsWith("scripts/"))).toEqual([
      "scripts/paper-pilot-sequence.ps1",
      "scripts/paper-pilot-sequence.core.ps1",
    ]);
    expect([...ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER]).toEqual([
      "backend/src/scripts/fresh-amm-v4-precheck.ts",
      "backend/src/scripts/fresh-amm-v4-precheck.test.ts",
      "backend/src/scripts/fresh-amm-v4-precheck.test-support.ts",
      "backend/src/scripts/paper-pilot-handoff.ts",
      "backend/src/scripts/paper-pilot-handoff.test.ts",
      ...added,
    ]);
    expect(REVIEWED_RUNNER_COMMIT).toBe("6855efb0e4ab5023e2c556030c42613a0ee86f53");
    const pinWith = (stdout: string, lsTree?: GitAnswer) =>
      checkPin(
        PINNED,
        fakeGit({ nameStatus: { status: 0, stdout }, ...(lsTree ? { lsTree } : {}) }).git,
      );
    expect(pinWith(added.map((f) => `A\t${f}`).join("\n"))).toEqual([]);
    for (const f of added) {
      expect(pinWith(`M\t${f}`), f).toEqual([`REVIEWED_RUNNER_DEPENDENCY_CHANGED:${f}`]);
      expect(pinWith(`D\t${f}`), f).toEqual([`REVIEWED_RUNNER_DEPENDENCY_CHANGED:${f}`]);
    }
    // A rename (compared without rename detection) is a deletion plus an unexpected addition.
    const renamed = "backend/src/candidate-scanner/BoundedAmmV4CreationWatchRenamed.ts";
    expect(pinWith(`D\t${added[0]}\nA\t${renamed}`)).toEqual([
      `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${added[0]}`,
      `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${renamed}`,
    ]);
    // Unexpected additions next to the reviewed files, and directories, are not allowed.
    for (const extra of [
      "backend/src/candidate-scanner/BoundedAmmV4CreationWatch.test-support.ts",
      "backend/src/candidate-scanner/RaydiumCpmmPoolStateAdapter.test-support.ts",
      "backend/src/candidate-scanner/RaydiumCpmmPoolStateAdapterExtra.ts",
      "backend/src/candidate-scanner/DexScreenerCpmmCandidateMarketParser.test-support.ts",
      "backend/src/candidate-scanner/DexScreenerCpmmCandidateMarketParserExtra.ts",
      "backend/src/candidate-scanner/RaydiumCpmmSwapDecoder.test-support.ts",
      "backend/src/candidate-scanner/RaydiumCpmmSwapDecoderExtra.ts",
      "backend/src/candidate-scanner/RaydiumCpmmSwapDecoder.fixtures.ts",
      "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapter.test-support.ts",
      "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapterExtra.ts",
      "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapter.fixtures.ts",
      "backend/src/candidate-scanner/RaydiumCpmmEvidenceRecorder.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.test-support.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedgerExtra.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.fixtures.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.harness.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccounting.ts",
      "backend/src/candidate-scanner/CpmmResolutionAccountingLedgerSummary.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationCollector.test-support.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationCollectorExtra.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationCollector.fixtures.ts",
      "backend/src/candidate-scanner/CpmmNotificationCollector.ts",
      "backend/src/candidate-scanner/CpmmPoolNotificationSealer.ts",
      "backend/src/candidate-scanner/CpmmPoolConnectionOwner.test-support.ts",
      "backend/src/candidate-scanner/CpmmPoolConnectionOwnerExtra.ts",
      "backend/src/candidate-scanner/CpmmPoolConnectionOwner.fixtures.ts",
      "backend/src/candidate-scanner/CpmmConnectionOwner.ts",
      "backend/src/candidate-scanner/CpmmPoolTransportWrapper.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransport.test-support.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransport.fixtures.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransportExtra.ts",
      "backend/src/candidate-scanner/CpmmPoolWebSocketTransportFactory.ts",
      "backend/src/candidate-scanner/CpmmWebSocketTransport.ts",
      "backend/src/scripts/evidence-credential-sanitizer.test-support.ts",
      "backend/src/scripts/evidence-credential-sanitizer.fixtures.ts",
      "backend/src/scripts/evidence-credential-sanitizer-extra.ts",
      "backend/src/scripts/evidence-sanitizer.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence.test-support.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence.fixtures.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence-extra.ts",
      "backend/src/scripts/cpmm-pool-observation-evidence-cli.ts",
      "backend/src/scripts/cpmm-observation-evidence.ts",
      "backend/src/candidate-scanner/cpmm-pool-observation-evidence.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorder.test-support.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorder.fixtures.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorderExtra.ts",
      "backend/src/candidate-scanner/CpmmPoolObservationRecorderFactory.ts",
      "backend/src/candidate-scanner/CpmmObservationRecorder.ts",
      "backend/src/scripts/CpmmPoolObservationRecorder.ts",
      "backend/src/candidate-scanner/CpmmPoolAccountAcquisition.test-support.ts",
      "backend/src/candidate-scanner/CpmmPoolAccountAcquisitionFactory.ts",
      "backend/src/scripts/CpmmPoolAccountAcquisition.ts",
      "backend/src/scripts/cpmm-pool-acquisition-evidence.ts",
      "backend/src/scripts/cpmm-pool-acquisition-evidence.test.ts",
      "backend/src/scripts/cpmm-pool-acquisition-cli.ts",
      "backend/src/scripts/fresh-amm-v4-watch-evidence.test-support.ts",
      "backend/src/scripts/fresh-amm-v4-watch.test-support.ts",
      "backend/src/scripts/fresh-amm-v4-watch-handoff.ts",
      "backend/src/scripts/amm-v4-watch-retrospective.test-support.ts",
      "backend/src/scripts/amm-v4-watch-retrospective-cli.ts",
      "backend/src/candidate-scanner",
      "backend/src/candidate-scanner/BoundedAmmV4CreationWatch.ts/extra.ts",
    ]) {
      expect(pinWith(`A\t${extra}`), extra).toEqual([
        `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${extra}`,
      ]);
    }
    // Other runner dependencies (not in REVIEWED_ENDPOINT_MODIFICATIONS) are refused when modified.
    expect(pinWith("M\tbackend/src/candidate-scanner/PaperRequestSession.ts")).toEqual([
      "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/candidate-scanner/PaperRequestSession.ts",
    ]);

    // Exact-version exceptions: reviewed endpoint modifications are accepted when matching.
    const reviewedModFiles = Object.keys(REVIEWED_ENDPOINT_MODIFICATIONS);
    expect(pinWith(reviewedModFiles.map((f) => `M\t${f}`).join("\n"))).toEqual([]);

    // Failure cases for reviewed endpoint modifications:
    // 1. Unreviewed blob
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "100644 blob 1111111111111111111111111111111111111111\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
          "100644 blob e5cf0d3dfe1c71e1cebfea46c24ab0bd516120ab\tbackend/src/scripts/paper-single-candidate-diagnostic.test.ts",
      }),
    ).toEqual([
      "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/paper-single-candidate-diagnostic.ts",
    ]);

    // 2. Wrong mode (executable 100755)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "100755 blob 42435317b0817f5463fcac804847faefee35c69b\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
          "100644 blob e5cf0d3dfe1c71e1cebfea46c24ab0bd516120ab\tbackend/src/scripts/paper-single-candidate-diagnostic.test.ts",
      }),
    ).toEqual([
      "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/paper-single-candidate-diagnostic.ts",
    ]);

    // 3. Wrong type (tree 040000)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "040000 tree 42435317b0817f5463fcac804847faefee35c69b\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
          "100644 blob e5cf0d3dfe1c71e1cebfea46c24ab0bd516120ab\tbackend/src/scripts/paper-single-candidate-diagnostic.test.ts",
      }),
    ).toEqual([
      "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/paper-single-candidate-diagnostic.ts",
    ]);

    // 4. Deletion / rename
    expect(
      pinWith("D\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "100644 blob e5cf0d3dfe1c71e1cebfea46c24ab0bd516120ab\tbackend/src/scripts/paper-single-candidate-diagnostic.test.ts",
      }),
    ).toEqual([
      "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/paper-single-candidate-diagnostic.ts",
    ]);

    // 5. Lookup failure (status 1)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 1,
        stdout: "",
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // 6. Malformed tree output
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout: "malformed ls-tree output without proper formatting",
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // Valid two-entry result: exactly one entry for each reviewed path with matching mode, type, and oid
    const validTreeStdout =
      "100644 blob 42435317b0817f5463fcac804847faefee35c69b\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
      "100644 blob e5cf0d3dfe1c71e1cebfea46c24ab0bd516120ab\tbackend/src/scripts/paper-single-candidate-diagnostic.test.ts";
    expect(
      pinWith(reviewedModFiles.map((f) => `M\t${f}`).join("\n"), {
        status: 0,
        stdout: validTreeStdout,
      }),
    ).toEqual([]);

    // 7. Conflicting duplicates (order 1: wrong blob first, then valid entry)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "100644 blob 1111111111111111111111111111111111111111\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
          validTreeStdout,
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // 8. Conflicting duplicates (order 2: valid entry first, then wrong blob)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          validTreeStdout +
          "\n100644 blob 1111111111111111111111111111111111111111\tbackend/src/scripts/paper-single-candidate-diagnostic.ts",
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // 9. Identical duplicates (valid entry repeated)
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          "100644 blob 42435317b0817f5463fcac804847faefee35c69b\tbackend/src/scripts/paper-single-candidate-diagnostic.ts\n" +
          validTreeStdout,
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // 10. Unexpected extra path
    expect(
      pinWith("M\tbackend/src/scripts/paper-single-candidate-diagnostic.ts", {
        status: 0,
        stdout:
          validTreeStdout +
          "\n100644 blob 2222222222222222222222222222222222222222\tbackend/src/scripts/unexpected-file.ts",
      }),
    ).toEqual(["REVIEWED_RUNNER_COMPARISON_FAILED"]);

    // Read-only git on this repository:
    // Every addition since reviewed runner is allowed, and the endpoint modifications
    // match REVIEWED_ENDPOINT_MODIFICATIONS, so checkPin succeeds with zero refusals.
    const git = defaultGit(fileURLToPath(new URL("../../../", import.meta.url)));
    const diff = git([
      "diff",
      "--name-status",
      "--no-renames",
      REVIEWED_RUNNER_COMMIT,
      "--",
      ...RUNNER_DEPENDENCY_PATHS,
    ]);
    expect(diff.status).toBe(0);
    const changes = diff.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
    for (const line of changes.filter((l) => l.startsWith("A\t"))) {
      expect(ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER, line).toContain(line.split("\t")[1]);
    }
    expect(changes.filter((l) => !l.startsWith("A\t")).sort()).toEqual(
      reviewedModFiles.sort().map((f) => `M\t${f}`),
    );
    expect(
      checkPin(PINNED, fakeGit({ nameStatus: { status: 0, stdout: diff.stdout } }).git),
    ).toEqual([]);
    expect(REVIEWED_RUNNER_COMMIT).toBe("6855efb0e4ab5023e2c556030c42613a0ee86f53");
    for (const f of reviewedModFiles) {
      expect(ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER).not.toContain(f);
    }
  });
  it("H-13: the handoff CLI routes explicit precheck or watch inputs, refuses conflicts, and exits with its decision's code", async () => {
    const root = watchRoot();
    const { env, validation } = await selectedWatch();
    const run = sealRun(root, "watch-cli", { watchResult: env.watchResult, validation });
    const cli = (args: string[], nowMs: number, projectRoot = root, git = fakeGit().git) => {
      const lines: string[] = [];
      const code = runHandoffCli(["--pinned-commit", PINNED, ...args], {
        projectRoot,
        git,
        clock: () => nowMs,
        log: (l) => lines.push(l),
      });
      expect(lines, args.join(" ")).toHaveLength(1);
      const decision = JSON.parse(lines[0]!) as Loose;
      // The exit code always matches the structured decision.
      expect(code, args.join(" ")).toBe(
        HANDOFF_EXIT_CODES[decision.decision as keyof typeof HANDOFF_EXIT_CODES],
      );
      return { code, decision };
    };
    const watchArgs = ["--watch-evidence-dir", run, "--pilot-out-dir", PILOT];
    const manifestSha256 = sha256(
      readFileSync(path.join(root, ...run.split("/"), WATCH_EVIDENCE_FILES.manifest)),
    );

    // Watch evidence: the verified manifest digest is part of the decision.
    const allowedNow = cli(watchArgs, watchAge(300));
    expect(allowedNow).toMatchObject({
      code: 0,
      decision: {
        decision: "ALLOWED",
        refusals: [],
        poolId: POOL,
        mintAddress: MINT,
        pilotOutDir: PILOT,
        evidenceSource: "WATCH_EVIDENCE",
        manifestSha256,
      },
    });
    expect(cli(watchArgs, watchAge(239))).toMatchObject({
      code: 2,
      decision: { decision: "WAIT", waitMs: 1000, manifestSha256 },
    });
    expect(cli(watchArgs, watchAge(761))).toMatchObject({
      code: 1,
      decision: { decision: "REFUSED", refusals: ["START_WINDOW_EXPIRED"] },
    });
    // The digest is the one the verifier read.
    expect(verifyWatchEvidence(path.join(root, ...run.split("/"))).manifestSha256).toBe(
      manifestSha256,
    );

    // The precheck invocation is unchanged: same decision as the function, no watch fields.
    const precheck = await sealedPrecheck();
    const viaCli = cli(
      ["--precheck-dir", PRECHECK, "--pilot-out-dir", PILOT],
      atAge(300),
      precheck.root,
    );
    expect(viaCli.decision).toEqual(
      JSON.parse(JSON.stringify(evaluate(precheck.root, atAge(300)))) as Loose,
    );
    expect(viaCli.decision).toMatchObject({ decision: "ALLOWED", poolId: POOL });
    expect(viaCli.decision.evidenceSource).toBeUndefined();
    expect(viaCli.decision.manifestSha256).toBeUndefined();
    // Precheck evidence given as watch evidence (and the reverse) is refused, never re-routed.
    expect(
      cli(["--watch-evidence-dir", PRECHECK, "--pilot-out-dir", PILOT], atAge(300), precheck.root)
        .code,
    ).toBe(1);
    expect(cli(["--precheck-dir", run, "--pilot-out-dir", PILOT], watchAge(300)).code).toBe(1);

    // Conflicting or missing inputs.
    for (const [args, refusal] of [
      [
        [...watchArgs, "--precheck-dir", PRECHECK],
        "HANDOFF_INPUT_CONFLICT:PRECHECK_AND_WATCH_EVIDENCE",
      ],
      [
        ["--pin-only", "--watch-evidence-dir", run],
        "HANDOFF_INPUT_CONFLICT:PIN_ONLY_WITH_EVIDENCE",
      ],
      [["--pin-only", "--precheck-dir", PRECHECK], "HANDOFF_INPUT_CONFLICT:PIN_ONLY_WITH_EVIDENCE"],
      [["--pin-only", "--pilot-out-dir", PILOT], "HANDOFF_INPUT_CONFLICT:PIN_ONLY_WITH_EVIDENCE"],
      [["--pilot-out-dir", PILOT], "HANDOFF_INPUT_MISSING:EVIDENCE_DIR"],
      [
        ["--watch-evidence-dir", "", "--pilot-out-dir", PILOT],
        "HANDOFF_INPUT_MISSING:WATCH_EVIDENCE_DIR",
      ],
    ] as const) {
      expect(cli([...args], watchAge(300)), args.join(" ")).toMatchObject({
        code: 1,
        decision: { decision: "REFUSED", refusals: [refusal] },
      });
    }
    expect(cli(["--pin-only"], watchAge(300))).toMatchObject({
      code: 0,
      decision: { decision: "PIN_OK", refusals: [] },
    });
    expect(() =>
      runHandoffCli(["--pinned-commit", PINNED, "--unknown"], { log: () => {} }),
    ).toThrow();
  });
});
