#!/usr/bin/env node
/**
 * NeXusTrade — bounded AMM v4 creation-watch entry point (collector → validator → sealer).
 *
 * Composes the reviewed components only; it adds no acquisition logic of its own:
 *
 * 1. `BoundedAmmV4CreationWatch`: one WebSocket connection, one logsSubscribe on the pinned fee
 *    destination, no reconnect or retry, at most one qualifying notification, 900 s ceiling and the
 *    reviewed message, keepalive and cleanup limits.
 * 2. `executeWatchCandidateValidation`: only after a captured notification and settled cleanup; at
 *    most one transaction retrieval and one market request (10 s timeouts, 1 MiB responses, the
 *    reviewed pacing), bounded by min(notification receipt + 30 s, watch start + 930 s).
 * 3. `sealWatchEvidence`: every terminal path is sealed with its original cause; credentials are
 *    passed explicitly for redaction. A write failure is reported and never triggers reacquisition.
 * 4. `verifyWatchEvidence`: integrity, completeness and confirmed selection reported separately.
 *
 * It never collects a signature page, never falls back to other discovery, never launches Stage B
 * and never waits for a start window. Importing this module performs no I/O. Help and the default
 * dry run print the plan without loading configuration, opening transports, sending requests or
 * writing files; `--verify` reads a sealed run offline. Acquisition needs the explicit `--live`
 * flag and remains AWAITING SEPARATE OPERATOR APPROVAL.
 *
 * Exit codes: 0 help, dry run, or a sealed (or verified) run whose selection is confirmed;
 * 1 invalid arguments, configuration or output location (nothing opened or written), or an
 * unexpected error; 3 sealed or verified with integrity but no confirmed selection; 4 integrity
 * failure; 5 sealing failed (nothing reacquired).
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  BoundedAmmV4CreationWatch,
  DEFAULT_CREATION_WATCH_LIMITS,
  type BoundedAmmV4CreationWatchResult,
} from "../candidate-scanner/BoundedAmmV4CreationWatch.js";
import {
  DEFAULT_WATCH_VALIDATION_LIMITS,
  OVERALL_SESSION_DEADLINE_MS,
  executeWatchCandidateValidation,
  type WatchCandidateValidationResult,
} from "../candidate-scanner/AmmV4WatchCandidateValidation.js";
import {
  WsWebSocketTransport,
  type ISolanaKeepaliveWebSocketTransport,
} from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import { getWebSocketTransportReadyState } from "../candidate-scanner/CandidateDecisionDiagnostic.js";
import { resolveSolanaEndpoints } from "./paper-single-candidate-diagnostic.js";
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";
import { serializeJsonPreservingBigInts } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { loadDaemonEnvironment } from "./paper-trading-daemon.js";
import {
  PLANNING_START_WINDOW,
  PRECHECK_APPROVAL_STATUS,
  PRECHECK_ROOT_SEGMENTS,
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  type EvidenceFileWriter,
} from "./fresh-amm-v4-precheck.js";
import {
  sealWatchEvidence,
  verifyWatchEvidence,
  type WatchEvidenceVerification,
  type WatchRunTerminalCause,
} from "./fresh-amm-v4-watch-evidence.js";

/** The reviewed, fixed limits (never overridden by this entry point). */
export const WATCH_RUN_POLICY = Object.freeze({
  webSocket: Object.freeze({
    connections: 1,
    subscriptions: 1,
    reconnects: 0,
    retries: 0,
    maxQualifyingNotifications: 1,
    feeDestination: RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
    limits: DEFAULT_CREATION_WATCH_LIMITS,
  }),
  validation: Object.freeze({
    transactionRetrievals: 1,
    marketRequests: 1,
    signaturePages: 0,
    limits: DEFAULT_WATCH_VALIDATION_LIMITS,
    deadline: "min(notification receipt + 30 s, watch start + 930 s)",
    overallSessionDeadlineMs: OVERALL_SESSION_DEADLINE_MS,
  }),
});

/** Same pattern as the sealer's run names: the output is one new directory in the precheck root. */
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const WATCH_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  NOT_CONFIRMED: 3,
  INTEGRITY_FAILED: 4,
  SEAL_FAILED: 5,
});

export const WATCH_USAGE = [
  "Usage: fresh-amm-v4-watch [--help] | --out-dir <dir> [--live] | --verify <dir>",
  "  --help            Print this usage and the proposed plan (nothing loaded, opened or written).",
  "  --out-dir <dir>   A new directory directly inside data/research/prechecks/ (default: dry run).",
  "  --live            Acquire: one bounded watch, validation and sealing (separate approval required).",
  "  --verify <dir>    Verify a sealed watch run offline (no configuration, no network).",
  "Exit codes: 0 confirmed or informational, 1 invalid input or error, 3 not confirmed,",
  "            4 integrity failure, 5 sealing failed.",
].join("\n");

export type WatchTimers = PaperRequestSessionTimers;

export interface FreshAmmV4WatchDeps {
  /** Configuration source for --live (default: process.env after the existing loader). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Existing configuration loader (default: loadDaemonEnvironment); called only for --live. */
  readonly loadEnvironment?: (() => void) | undefined;
  readonly createWebSocketTransport?:
    | ((wsUrl: string) => ISolanaKeepaliveWebSocketTransport)
    | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: WatchTimers | undefined;
  readonly projectRoot?: string | undefined;
  /** Operator cancellation (any stage); evidence is still sealed. */
  readonly signal?: AbortSignal | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Offline tests only: called at each stage boundary (to cancel between stages). */
  readonly onStage?: ((stage: WatchRunStageBoundary) => void) | undefined;
  /** Offline tests only: replaces the sealer's exclusive writer (to force a write failure). */
  readonly writeEvidenceFile?: EvidenceFileWriter | undefined;
}

export type WatchRunStageBoundary =
  | "BEFORE_WATCH"
  | "AFTER_WATCH"
  | "AFTER_VALIDATION"
  | "BEFORE_SEAL";

export interface WatchVerificationReport {
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly completeness: {
    readonly sufficientForSelection: boolean;
    readonly reasons: readonly string[];
  };
  readonly rederivation: string;
  readonly selectionConfirmed: boolean;
  readonly confirmedTarget: { readonly poolId: string; readonly mintAddress: string } | null;
}

export interface FreshAmmV4WatchResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string | undefined;
  readonly outDir?: string | undefined;
  readonly watchStatus?: string | undefined;
  readonly validationOutcome?: string | null | undefined;
  readonly terminalCause?: WatchRunTerminalCause | undefined;
  /**
   * Cancellation observed after validation finished and before sealing started: the completed
   * validation and its exchanges are sealed unchanged, but the run is sealed as OPERATOR_CANCELLED
   * at RUN, so it is never actionable.
   */
  readonly cancellationAfterValidation?: boolean | undefined;
  readonly seal?:
    | {
        readonly ok: boolean;
        readonly status: string;
        readonly manifestSha256: string | null;
        readonly reason: string | null;
      }
    | undefined;
  readonly verification?: WatchVerificationReport | undefined;
  readonly cleanup?:
    | {
        readonly transportsOpened: number;
        readonly transportsForceClosed: number;
        readonly transportsStillOpen: number;
      }
    | undefined;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function cliError(message: string): Error {
  return new Error(`[CLI_INVALID_ARG] ${message}`);
}

export function buildWatchPlan(outDirRelative: string, mode: "DRY_RUN" | "LIVE") {
  return {
    kind: "PAPER_FRESH_AMM_V4_WATCH_RUN_PLAN",
    executionContext: "PAPER_SIMULATION",
    mode,
    approval: PRECHECK_APPROVAL_STATUS,
    outDir: outDirRelative,
    endpoints: {
      solanaRpc: "SOLANA_RPC_URL (configuration; never printed)",
      webSocket:
        "SOLANA_WS_URL (configuration; never printed), required for Alchemy RPC hosts; otherwise derived from SOLANA_RPC_URL (http->ws, https->wss)",
      market:
        "https://api.dexscreener.com/latest/dex/tokens/<decoded candidate mint> (the runner's endpoint)",
    },
    policy: WATCH_RUN_POLICY,
    startWindow: PLANNING_START_WINDOW,
    sequence: [
      "Validate the new output directory (refuse an existing one) before any transport",
      "One bounded watch: one connection and subscription; at most one qualifying notification",
      "Validation only after a captured notification and settled cleanup: one getTransaction, then one market request only for a qualifying AMM v4 initialization",
      "Seal every terminal path with its original cause (no capture, cancellation, rejection, selection, run failure)",
      "Verify the sealed evidence and report integrity, completeness and confirmed selection separately",
    ],
    boundaries: [
      "No signature page, no fallback discovery, no reconnect, no retry, no polling",
      "No Stage B launch and no start-window wait: the run ends after sealing and reporting",
      "A write failure is reported and never triggers reacquisition",
      "A selected target is PROVISIONAL: security and strategy eligibility are unverified",
    ],
  };
}

type Parsed =
  | { readonly mode: "HELP" }
  | { readonly mode: "VERIFY"; readonly dir: string }
  | { readonly mode: "DRY_RUN" | "LIVE"; readonly outDir: string };

function parseCli(rawArgs: readonly string[]): Parsed {
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        "out-dir": { type: "string" },
        verify: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err));
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === undefined) continue;
    if (seen.has(t.name)) throw cliError(`--${t.name} may be given only once`);
    seen.add(t.name);
  }
  if (values.help === true) {
    if (seen.size > 1) throw cliError("--help cannot be combined with other options");
    return { mode: "HELP" };
  }
  if (values.verify !== undefined) {
    if (values.live === true || values["out-dir"] !== undefined) {
      throw cliError("--verify cannot be combined with --live or --out-dir");
    }
    if (typeof values.verify !== "string" || values.verify === "") {
      throw cliError("--verify needs a sealed run directory");
    }
    return { mode: "VERIFY", dir: values.verify };
  }
  const rawOut = typeof values["out-dir"] === "string" ? values["out-dir"] : "";
  if (rawOut === "") throw cliError("--out-dir is required (a new directory)");
  return { mode: values.live === true ? "LIVE" : "DRY_RUN", outDir: rawOut };
}

/** A new run directory directly inside the precheck root (checked before anything is opened). */
function resolveNewRunDir(projectRoot: string, rawOut: string) {
  const root = path.join(projectRoot, ...PRECHECK_ROOT_SEGMENTS);
  const outDir = path.resolve(projectRoot, rawOut);
  const runName = path.basename(outDir);
  if (path.dirname(outDir) !== root || !RUN_NAME.test(runName)) {
    throw cliError(
      `--out-dir must be a new directory directly inside ${PRECHECK_ROOT_SEGMENTS.join("/")}/ (letters, digits, '.', '_', '-')`,
    );
  }
  if (existsSync(outDir)) {
    throw new Error(
      `[OUTPUT_EXISTS] ${path.relative(projectRoot, outDir).replace(/\\/g, "/")} already exists; refusing to overwrite`,
    );
  }
  return { outDir, runName, rel: path.relative(projectRoot, outDir).replace(/\\/g, "/") };
}

function verificationReport(v: WatchEvidenceVerification): WatchVerificationReport {
  return {
    integrity: { ok: v.integrity.ok, problems: [...v.integrity.problems] },
    completeness: {
      sufficientForSelection: v.completeness.sufficientForSelection,
      reasons: [...v.completeness.reasons],
    },
    rederivation: v.rederivation.status,
    selectionConfirmed: v.selectionConfirmed,
    confirmedTarget:
      v.confirmedTarget === null
        ? null
        : { poolId: v.confirmedTarget.poolId, mintAddress: v.confirmedTarget.mintAddress },
  };
}

const exitFor = (r: WatchVerificationReport) =>
  !r.integrity.ok
    ? WATCH_EXIT_CODES.INTEGRITY_FAILED
    : r.selectionConfirmed
      ? WATCH_EXIT_CODES.OK
      : WATCH_EXIT_CODES.NOT_CONFIRMED;

function logVerification(out: (line: string) => void, prefix: string, r: WatchVerificationReport) {
  out(
    `[${prefix}] Integrity: ${r.integrity.ok ? "OK" : `FAILED (${r.integrity.problems.join(", ")})`}`,
  );
  out(
    `[${prefix}] Completeness: ${r.completeness.sufficientForSelection ? "SUFFICIENT" : `INSUFFICIENT (${r.completeness.reasons.join(", ")})`}`,
  );
  out(`[${prefix}] Re-derivation: ${r.rederivation}`);
  out(
    `[${prefix}] Selection: ${r.confirmedTarget ? `CONFIRMED (PROVISIONAL target: pool ${r.confirmedTarget.poolId} mint ${r.confirmedTarget.mintAddress})` : "NOT CONFIRMED"}`,
  );
}

/** The bracketed code of an error message, never its free text (which could carry a value). */
const errorCode = (err: unknown) => {
  const m = /^\[([A-Z0-9_]+)\]/.exec(err instanceof Error ? err.message : "");
  return m ? m[1] : "UNEXPECTED_ERROR";
};

/** Errors raised by this entry point carry fixed text only; anything else prints its code. */
const OWN_ERROR_CODES = new Set([
  "CLI_INVALID_ARG",
  "OUTPUT_EXISTS",
  "MISSING_CONFIGURATION",
  "INVALID_CONFIGURATION",
  "WATCH_FAILED_UNSEALED",
]);
export const printableError = (err: unknown): string =>
  OWN_ERROR_CODES.has(errorCode(err) ?? "") && err instanceof Error
    ? err.message
    : `[${errorCode(err)}]`;

export async function runFreshAmmV4Watch(
  rawArgs: readonly string[],
  deps: FreshAmmV4WatchDeps = {},
): Promise<FreshAmmV4WatchResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const parsed = parseCli(rawArgs);

  if (parsed.mode === "HELP") {
    const planJson = serializeJsonPreservingBigInts(
      buildWatchPlan("<new directory inside data/research/prechecks/>", "DRY_RUN"),
    );
    log(WATCH_USAGE);
    log("[HELP] No configuration loaded, no transport opened, no request sent, nothing written.");
    log(planJson);
    return { mode: "HELP", exitCode: WATCH_EXIT_CODES.OK, planDigestSha256: sha256(planJson) };
  }

  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());

  if (parsed.mode === "VERIFY") {
    const root = path.join(projectRoot, ...PRECHECK_ROOT_SEGMENTS);
    const dir = path.resolve(projectRoot, parsed.dir);
    const rel = path.relative(root, dir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw cliError(`--verify must name a run inside ${PRECHECK_ROOT_SEGMENTS.join("/")}/`);
    }
    const report = verificationReport(verifyWatchEvidence(dir));
    logVerification(log, "VERIFY", report);
    return {
      mode: "VERIFY",
      exitCode: exitFor(report),
      outDir: path.relative(projectRoot, dir).replace(/\\/g, "/"),
      verification: report,
    };
  }

  const target = resolveNewRunDir(projectRoot, parsed.outDir);
  const plan = buildWatchPlan(target.rel, parsed.mode);
  const planJson = serializeJsonPreservingBigInts(plan);
  const planDigestSha256 = sha256(planJson);
  if (parsed.mode === "DRY_RUN") {
    log(
      "[DRY_RUN] No configuration loaded, no transport opened, no request sent, nothing written.",
    );
    log(`[DRY_RUN] Live execution: ${PRECHECK_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode: "DRY_RUN", exitCode: WATCH_EXIT_CODES.OK, planDigestSha256 };
  }

  // ------------------------------------------------------------------------------------------
  // Explicit live path (awaiting separate operator approval). Configuration is loaded only here.
  // ------------------------------------------------------------------------------------------
  (deps.loadEnvironment ?? loadDaemonEnvironment)();
  const env = deps.env ?? process.env;
  // The shared resolver: HTTP requests use SOLANA_RPC_URL; the WebSocket uses SOLANA_WS_URL, or
  // the scheme-derived URL only for providers that serve both on one host. Nothing is printed.
  const endpoints = resolveSolanaEndpoints(env);
  if (!endpoints.ok) throw new Error(endpoints.error);
  const { rpcUrl, wsUrl: wssUrl } = endpoints;
  return runLive({ deps, log, projectRoot, target, plan, planDigestSha256, rpcUrl, wssUrl });
}

async function runLive(a: {
  deps: FreshAmmV4WatchDeps;
  log: (line: string) => void;
  projectRoot: string;
  target: { outDir: string; runName: string; rel: string };
  plan: ReturnType<typeof buildWatchPlan>;
  planDigestSha256: string;
  rpcUrl: string;
  wssUrl: string;
}): Promise<FreshAmmV4WatchResult> {
  const { deps, log, target } = a;
  const clock = deps.clock ?? (() => Date.now());
  const signal = deps.signal;
  const stage = (s: WatchRunStageBoundary) => deps.onStage?.(s);
  log(`[LIVE] ${PRECHECK_APPROVAL_STATUS}`);
  log(`[LIVE] Plan digest (sha256): ${a.planDigestSha256}`);

  // The output location is re-checked immediately before the transport can open.
  if (existsSync(target.outDir)) {
    throw new Error(`[OUTPUT_EXISTS] ${target.rel} already exists; refusing to overwrite`);
  }

  // Transports are created only by the collector, through this owned factory.
  const transports: ISolanaKeepaliveWebSocketTransport[] = [];
  const factory = (url: string) => {
    const t = deps.createWebSocketTransport
      ? deps.createWebSocketTransport(url)
      : new WsWebSocketTransport(url);
    transports.push(t);
    return t;
  };
  let transportsForceClosed = 0;
  const closeOwnedTransports = () => {
    for (const t of transports) {
      if (getWebSocketTransportReadyState(t) === 3) continue;
      try {
        if (typeof t.terminate === "function") t.terminate();
        else t.close();
      } catch {
        // Reported below as still open.
      }
      transportsForceClosed++;
    }
  };

  // 1. The bounded watch (reviewed limits; nothing overridden).
  stage("BEFORE_WATCH");
  let watchResult: BoundedAmmV4CreationWatchResult;
  try {
    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: a.wssUrl,
      transportFactory: factory,
      clock,
      timers: deps.timers,
      abortSignal: signal,
    });
    watchResult = await watch.start();
  } catch (err) {
    closeOwnedTransports();
    throw new Error(`[WATCH_FAILED_UNSEALED] ${errorCode(err)}`);
  }
  // The collector settles its own cleanup; anything it could not close is terminated here.
  closeOwnedTransports();
  stage("AFTER_WATCH");
  const obs = watchResult.observations;
  log(`[LIVE] Watch: ${watchResult.status}`);

  // 2. Validation only after a captured notification and settled, successful cleanup.
  let validation: WatchCandidateValidationResult | null = null;
  let cause: WatchRunTerminalCause;
  if (watchResult.status === "OPERATOR_CANCELLED") {
    cause = { code: "OPERATOR_CANCELLED", stage: "WATCH", detail: watchResult.reason };
  } else if (watchResult.status !== "NOTIFICATION_CAPTURED") {
    cause = { code: "WATCH_ENDED_WITHOUT_CAPTURE", stage: "WATCH", detail: watchResult.reason };
  } else if (!obs.cleanupSettled || obs.cleanupFailed) {
    cause = {
      code: "RUN_FAILED",
      stage: "WATCH",
      detail: `COLLECTOR_CLEANUP_NOT_SETTLED: ${obs.cleanupFailureReason ?? "cleanup did not settle"}`,
    };
  } else if (signal?.aborted) {
    cause = {
      code: "OPERATOR_CANCELLED",
      stage: "RUN",
      detail: "Operator cancellation after capture, before validation",
    };
  } else {
    try {
      validation = await executeWatchCandidateValidation({
        watchResult,
        rpcUrl: a.rpcUrl,
        fetchFn: deps.fetchFn ?? globalThis.fetch,
        clock,
        timers: deps.timers,
        abortSignal: signal,
      });
      cause =
        validation.outcome === "OPERATOR_CANCELLED"
          ? { code: "OPERATOR_CANCELLED", stage: "VALIDATION", detail: validation.reason }
          : { code: "COMPLETED", stage: "VALIDATION", detail: null };
    } catch (err) {
      validation = null;
      cause = {
        code: "RUN_FAILED",
        stage: "VALIDATION",
        detail: `VALIDATION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    log(`[LIVE] Validation: ${validation?.outcome ?? "NOT_RECORDED"}`);
  }
  stage("AFTER_VALIDATION");
  stage("BEFORE_SEAL");

  // 3. Cancellation is checked after the stage hooks, immediately before the sealer is called. A
  //    cancellation observed here turns a completed run into a cancelled one (the completed
  //    validation and its exchanges are kept); an earlier failure or cancellation cause is kept.
  const cancellationAfterValidation = cause.code === "COMPLETED" && signal?.aborted === true;
  if (cancellationAfterValidation) {
    cause = {
      code: "OPERATOR_CANCELLED",
      stage: "RUN",
      detail: "Operator cancellation after validation finished, before sealing",
    };
  }

  // 4. Seal (uninterrupted: nothing checks the signal from here on; never retried).
  const sealed = sealWatchEvidence({
    projectRoot: a.projectRoot,
    runName: target.runName,
    plan: a.plan,
    watchResult,
    validation,
    terminalCause: cause,
    credentials: { rpcUrl: a.rpcUrl, wssUrl: a.wssUrl },
    clock,
    writeEvidenceFile: deps.writeEvidenceFile,
  });
  const transportsStillOpen = transports.filter(
    (t) => getWebSocketTransportReadyState(t) !== 3,
  ).length;
  const cleanup = {
    transportsOpened: transports.length,
    transportsForceClosed,
    transportsStillOpen,
  };
  const common = {
    mode: "LIVE" as const,
    planDigestSha256: a.planDigestSha256,
    outDir: target.rel,
    watchStatus: watchResult.status,
    validationOutcome: validation?.outcome ?? null,
    terminalCause: cause,
    cancellationAfterValidation,
    cleanup,
  };
  if (!sealed.ok) {
    log(`[LIVE] Sealing FAILED: ${sealed.status} (no reacquisition)`);
    return {
      ...common,
      exitCode: WATCH_EXIT_CODES.SEAL_FAILED,
      seal: { ok: false, status: sealed.status, manifestSha256: null, reason: sealed.reason },
    };
  }
  log(`[LIVE] Evidence sealed: ${target.rel} (manifest sha256 ${sealed.manifestSha256})`);
  log(`[LIVE] Terminal cause: ${sealed.runCause.code} at ${sealed.runCause.stage}`);
  if (cancellationAfterValidation) {
    log(
      "[LIVE] Cancelled after validation finished: the evidence is sealed as OPERATOR_CANCELLED and is not actionable.",
    );
  }

  // 5. Offline verification of what was sealed.
  const report = verificationReport(verifyWatchEvidence(target.outDir));
  logVerification(log, "LIVE", report);
  log("[LIVE] Ends here: no Stage B launch and no start-window wait.");
  return {
    ...common,
    exitCode: exitFor(report),
    seal: { ok: true, status: sealed.status, manifestSha256: sealed.manifestSha256, reason: null },
    verification: report,
  };
}

if (process.argv[1] && process.argv[1].endsWith("fresh-amm-v4-watch.ts")) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  runFreshAmmV4Watch(process.argv.slice(2), { signal: controller.signal })
    .then((r) => {
      process.removeListener("SIGINT", onSignal);
      process.exit(r.exitCode);
    })
    .catch((err: unknown) => {
      process.removeListener("SIGINT", onSignal);
      console.error("[FRESH_AMM_V4_WATCH_ERROR]", printableError(err));
      process.exit(WATCH_EXIT_CODES.INVALID);
    });
}
