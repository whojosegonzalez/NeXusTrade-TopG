#!/usr/bin/env node
/**
 * Roadmap step 3 (assessment §8.38.17 item 17 T): the entry point for one CPMM pool observation
 * run over the accepted composition core (`cpmm-pool-observation-run.ts`). It adds no acquisition,
 * observation, sealing or verification logic of its own.
 *
 * Modes:
 * - `--help` and the default dry run print the plan and the complete proposed profile. They load
 *   no environment or credential, construct no transport, send nothing and write nothing.
 * - `--live` runs the core once for one explicit pool, candidate mint and run id. It requires
 *   explicitly configured `SOLANA_RPC_URL` (https) and `SOLANA_WS_URL` (wss), resolved by the
 *   reviewed endpoint resolver. The flag only selects the acquiring mode: it is not, and does not
 *   record, operator approval. The proposed profile's live limits are not approved.
 * - `--verify <observation-dir> --acquisition-dir <dir>` verifies both bundles offline. It never
 *   loads configuration or credentials, so transaction re-analysis is reported as unavailable.
 *
 * There is no discovery, target selection, retry, reconnect, fallback or follow-up. Credential
 * values, raw configuration and free exception text are never printed: only refusals this entry
 * point creates itself carry text; any other error prints a fixed code.
 *
 * Exit codes: 0 help, dry run, or a successful run (or verification) with complete, reproduced
 * evidence; 1 invalid arguments, configuration, output location or setup refusal (nothing
 * opened or written), or an unexpected error; 2 evidence intact but limited (incomplete retention
 * or re-derivation not reproduced); 3 the run failed with its evidence intact; 4 evidence not
 * verified (integrity, acquisition binding or a re-derivation mismatch); 5 a bundle could not be
 * sealed (nothing reacquired); 6 cancelled, with its evidence intact; 7 the run would have
 * exited 0 or 2, but a signal listener could not be removed.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CpmmWsClientConstructor } from "../candidate-scanner/CpmmPoolWebSocketTransport.js";
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import {
  verifyCpmmPoolAcquisitionEvidence,
  type CpmmPoolAcquisitionVerification,
} from "./cpmm-pool-acquisition-evidence.js";
import {
  CPMM_EVIDENCE_FALSE_FLAGS,
  CPMM_EVIDENCE_ROOT_SEGMENTS,
  CPMM_EVIDENCE_VERIFIER_LIMITS,
  verifyCpmmObservationEvidence,
  type CpmmEvidenceVerification,
} from "./cpmm-pool-observation-evidence.js";
import {
  CPMM_ACQUISITION_ROOT_SEGMENTS,
  runCpmmPoolObservation,
  type CpmmObservationRunLimits,
  type CpmmObservationRunResult,
} from "./cpmm-pool-observation-run.js";
import { EVIDENCE_SANITIZER_LIMITS } from "./evidence-credential-sanitizer.js";

// ---------------------------------------------------------------------------------------------
// The proposed profile (for review; no live limit is approved)
// ---------------------------------------------------------------------------------------------

export const CPMM_OBSERVATION_PROFILE_LABEL = "PROPOSED_SHORT_OBSERVATION_PROFILE_V1" as const;
export const CPMM_OBSERVATION_PROFILE_STATUS =
  "PROPOSED_FOR_REVIEW_LIVE_LIMITS_NOT_APPROVED" as const;
export const CPMM_OBSERVATION_LIVE_STATUS =
  "NOT_APPROVED: the proposed profile awaits independent review and the operator-limit review" as const;
export const CPMM_OBSERVATION_LIVE_FLAG_MEANING =
  "--live only selects the acquiring mode; it is not, and does not record, operator approval" as const;

/** Two `getMultipleAccounts` requests: discovery, then the paced snapshot. */
export const CPMM_ACQUISITION_REQUESTS = 2;
/** Lifetime headroom beyond the acquisition and the owner's ceiling (the stage boundary). */
export const CPMM_PROFILE_LIFETIME_MARGIN_MS = 5_000;

const RPC_PACING_MS = 2_500;
const RPC_MAX_RESPONSE_BYTES = 262_144;
const MAX_HTTP_ATTEMPTS = 10;
const FRAME_BYTES = 65_536;
const EPOCH_BYTES = 1_048_576;
const OWNER = {
  observationMs: 60_000,
  ackTimeoutMs: 10_000,
  unsubscribeAckTimeoutMs: 5_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 5_000,
  maxPings: 3,
  maxPongReplies: 4,
  maxControlFrames: 16,
  maxControlPayloadBytes: 125,
  maxOutstandingResolutions: 4,
  maxRetainedUnprocessed: 8,
  drainMs: 20_000,
  cleanupTimeoutMs: 5_000,
} as const;
const ACQUISITION = { durationMs: 15_000, timeoutMs: 5_000, maxResponseBytes: 16_384 } as const;
const DISABLED_LANE = { maxAttempts: 0, pacingMs: 1, maxResponseBytes: 1 } as const;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Every effective limit the core receives in `--live`; nothing is overridden at run time. */
export const CPMM_OBSERVATION_PROFILE_LIMITS: CpmmObservationRunLimits = deepFreeze({
  session: {
    lifetimeMs:
      ACQUISITION.durationMs +
      OWNER.observationMs +
      OWNER.unsubscribeAckTimeoutMs +
      Math.max(OWNER.drainMs, OWNER.cleanupTimeoutMs) +
      CPMM_PROFILE_LIFETIME_MARGIN_MS,
    maxHttpAttempts: MAX_HTTP_ATTEMPTS,
    requestTimeoutMs: 10_000,
    lanes: {
      SOLANA_RPC: {
        maxAttempts: MAX_HTTP_ATTEMPTS,
        pacingMs: RPC_PACING_MS,
        maxResponseBytes: RPC_MAX_RESPONSE_BYTES,
      },
      RUGCHECK: { ...DISABLED_LANE },
      SOLANA_TRACKER: { ...DISABLED_LANE },
      DEXSCREENER: { ...DISABLED_LANE },
    },
  },
  acquisition: { ...ACQUISITION },
  owner: { ...OWNER },
  wrapper: {
    maxFrameBytes: FRAME_BYTES,
    maxFragments: 16,
    maxBufferedChunks: 64,
    handshakeTimeoutMs: 5_000,
    closeTimeoutMs: 5_000,
  },
  collector: {
    maxFrameBytes: FRAME_BYTES,
    maxEpochFrames: 128,
    maxEpochBytes: EPOCH_BYTES,
    maxRetainedFrameRecords: 129,
    maxRetainedNotifications: 128,
    maxEpochs: 1,
  },
  ledger: { maxSignatureRecords: 128, maxDuplicateDetailsPerRecord: 4, maxEpochs: 1 },
  adapter: { maxTrackedSignatures: 128, maxResponseBytes: RPC_MAX_RESPONSE_BYTES },
  evidenceRecorder: { maxPendingEvidence: MAX_HTTP_ATTEMPTS },
  recorder: {
    maxIncomingRecords: 160,
    maxIncomingPayloadBytes: EPOCH_BYTES,
    maxOutgoingRecords: 8,
    maxOutgoingPayloadBytes: 8_192,
    maxControlRecords: 64,
    maxControlPayloadBytes: 8_192,
    maxLifecycleRecords: 128,
    maxExchangeRecords: 16,
    maxExchangeBodyBytes: MAX_HTTP_ATTEMPTS * RPC_MAX_RESPONSE_BYTES,
    maxLedgerCallRecords: 256,
    maxInstrumentationFailures: 16,
    maxPayloadBytesPerRecord: RPC_MAX_RESPONSE_BYTES,
    maxFinishCopyNodes: 200_000,
  },
  fanOut: { maxRetainedFailures: 8 },
});

/** Fixed run constants (one connection, one epoch). */
export const CPMM_OBSERVATION_RUN_CONSTANTS = deepFreeze({
  epoch: 1,
  subscribeRequestId: 1,
  unsubscribeRequestId: 2,
});

/**
 * The accepted components' versions, recorded in the observation manifest: the commit that last
 * changed each component file.
 */
export const CPMM_OBSERVATION_COMPONENT_VERSIONS: Readonly<Record<string, string>> = deepFreeze({
  owner: "446eec4",
  wrapper: "87b50b3",
  collector: "dfeee4c",
  ledger: "dfeee4c",
  adapter: "2fd2f16",
  decoder: "3bc17a9",
  session: "bebe191",
  recorder: "5de691f",
  sanitizer: "573738f",
});
export const CPMM_OBSERVATION_COMPONENT_SOURCES: Readonly<Record<string, string>> = deepFreeze({
  owner: "backend/src/candidate-scanner/CpmmPoolConnectionOwner.ts",
  wrapper: "backend/src/candidate-scanner/CpmmPoolWebSocketTransport.ts",
  collector: "backend/src/candidate-scanner/CpmmPoolNotificationCollector.ts",
  ledger: "backend/src/candidate-scanner/CpmmResolutionAccountingLedger.ts",
  adapter: "backend/src/candidate-scanner/RaydiumCpmmTransactionSourceAdapter.ts",
  decoder: "backend/src/candidate-scanner/RaydiumCpmmSwapDecoder.ts",
  session: "backend/src/candidate-scanner/PaperRequestSession.ts",
  recorder: "backend/src/candidate-scanner/CpmmPoolObservationRecorder.ts",
  sanitizer: "backend/src/scripts/evidence-credential-sanitizer.ts",
});

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

export const CPMM_OBSERVATION_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  EVIDENCE_LIMITED: 2,
  RUN_FAILED: 3,
  EVIDENCE_NOT_VERIFIED: 4,
  SEAL_FAILED: 5,
  CANCELLED: 6,
  CLEANUP_FAILED: 7,
});

/**
 * Upper bound on graceful shutdown once the result is known. The exit code is set and the event
 * loop drains: an idle HTTP connection or a closing socket may still be releasing its handle, and
 * exiting at once can tear it down (assessment §8.38.19, `UV_HANDLE_CLOSING`). Only a process still
 * alive past this bound is forced to exit, with the same code and a fixed notice. The timer is
 * unref'd, so it never delays a process that drains on its own.
 */
export const CPMM_OBSERVATION_SHUTDOWN_GRACE_MS = 5_000;
export const CPMM_OBSERVATION_SHUTDOWN_FORCED_NOTICE = "[CPMM_POOL_OBSERVATION_SHUTDOWN_FORCED]";

export const CPMM_OBSERVATION_USAGE = [
  "Usage: cpmm-pool-observation --help",
  "     | cpmm-pool-observation --pool <address> --mint <address> --run-id <id> [--live]",
  "     | cpmm-pool-observation --verify <observation-dir> --acquisition-dir <acquisition-dir>",
  "  --help               Print this usage and the proposed plan (nothing loaded, opened or written).",
  "  --pool <address>     The exact Raydium CPMM pool account (no discovery or selection).",
  "  --mint <address>     The exact candidate mint of that pool.",
  "  --run-id <id>        New run id for both bundles (letters, digits, '_', '-'; up to 64).",
  "                       Without --live: dry run (plan and complete limits only).",
  "  --live               Acquire and observe once with the proposed profile. Requires explicit",
  "                       SOLANA_RPC_URL (https) and SOLANA_WS_URL (wss). Not operator approval.",
  "  --verify <dir>       Verify a sealed observation bundle offline (no configuration loaded).",
  "  --acquisition-dir <dir>  Its acquisition bundle (required with --verify).",
  "Exit codes: 0 succeeded or informational, 1 invalid input or error, 2 evidence limited,",
  "            3 run failed, 4 evidence not verified, 5 sealing failed, 6 cancelled,",
  "            7 a signal listener could not be removed (otherwise 0 or 2).",
].join("\n");

export type CpmmObservationSignal = "SIGINT" | "SIGTERM";
export const CPMM_OBSERVATION_SIGNALS: readonly CpmmObservationSignal[] = Object.freeze([
  "SIGINT",
  "SIGTERM",
]);

/** The process's signal registration (the CLI only adds and removes its own listener). */
export interface CpmmObservationSignalSource {
  on(event: CpmmObservationSignal, listener: () => void): unknown;
  removeListener(event: CpmmObservationSignal, listener: () => void): unknown;
}

export interface CpmmObservationCliDeps {
  /** Configuration source for --live only (default: process.env after the existing loader). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Existing configuration loader (default: loadDaemonEnvironment); called only for --live. */
  readonly loadEnvironment?: (() => void | Promise<void>) | undefined;
  /** Default: the global fetch, read only in --live after validation. */
  readonly fetchFn?: typeof fetch | undefined;
  /** Default: imports the installed `ws` client, only in --live after validation. */
  readonly loadWebSocketConstructor?: (() => Promise<CpmmWsClientConstructor>) | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  /** Default: the process. Listeners exist only while the core runs. */
  readonly signals?: CpmmObservationSignalSource | undefined;
  readonly projectRoot?: string | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface CpmmObservationEvidenceReport {
  readonly acquisition: {
    readonly path: string | null;
    readonly seal: string;
    readonly manifestSha256: string | null;
    readonly integrity: "VERIFIED" | "FAILED" | "NOT_VERIFIED";
    readonly integrityCode: string | null;
    readonly computed: CpmmPoolAcquisitionVerification["computed"] | null;
  };
  readonly observation: {
    readonly path: string | null;
    readonly seal: string;
    readonly manifestSha256: string | null;
    readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] } | null;
    readonly retention: { readonly status: string; readonly reasons: readonly string[] } | null;
    readonly rederivation: {
      readonly status: string;
      readonly implementedComponents: string | null;
      readonly transactionAnalysis: string | null;
      readonly transactionAnalysisUnavailableReason: string | null;
    } | null;
    readonly acquisitionBinding: string | null;
    readonly poolContextProvenance: string | null;
  };
}

export interface CpmmObservationCliReport {
  readonly execution: {
    readonly status: CpmmObservationRunResult["status"];
    readonly firstFailure: string | null;
    readonly clockFailure: string | null;
    readonly finalizationCancelled: boolean;
    readonly cancelled: boolean;
    readonly cleanupFailures: readonly string[];
    readonly sessionStopReason: string | null;
    readonly ownerTerminalCause: string | null;
    readonly connectionRunClean: boolean | null;
  };
  readonly requests: {
    readonly httpAttempts: number;
    readonly acquisitionRequests: number;
    readonly observationRequests: number;
    readonly webSocketConnections: number;
  };
  readonly evidence: CpmmObservationEvidenceReport;
  readonly flags: typeof CPMM_EVIDENCE_FALSE_FLAGS;
  /** The entry point's own cleanup, outside the core's frozen result. */
  readonly entryPoint: { readonly signalCleanupFailures: readonly string[] };
}

export interface CpmmObservationCliResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string;
  readonly report?: CpmmObservationCliReport;
  readonly verification?: CpmmObservationEvidenceReport;
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

const L = CPMM_OBSERVATION_PROFILE_LIMITS;

export function buildCpmmObservationPlan(input: {
  readonly mode: "DRY_RUN" | "LIVE";
  readonly runId: string;
  readonly target: { readonly poolAddress: string; readonly candidateMint: string };
  readonly acquisitionDir: string;
  readonly observationDir: string;
}) {
  const drainOrCleanupMs = Math.max(L.owner.drainMs, L.owner.cleanupTimeoutMs);
  const requiredLifetimeMs =
    L.acquisition.durationMs +
    L.owner.observationMs +
    L.owner.unsubscribeAckTimeoutMs +
    drainOrCleanupMs;
  return {
    kind: "CPMM_POOL_OBSERVATION_CLI_PLAN",
    version: 1,
    executionContext: "PAPER_RESEARCH_OBSERVATION_ONLY",
    mode: input.mode,
    liveExecution: CPMM_OBSERVATION_LIVE_STATUS,
    liveFlag: CPMM_OBSERVATION_LIVE_FLAG_MEANING,
    profile: {
      label: CPMM_OBSERVATION_PROFILE_LABEL,
      status: CPMM_OBSERVATION_PROFILE_STATUS,
      limits: L,
      runConstants: CPMM_OBSERVATION_RUN_CONSTANTS,
    },
    target: { poolAddress: input.target.poolAddress, candidateMint: input.target.candidateMint },
    runId: input.runId,
    outputs: {
      acquisitionDir: input.acquisitionDir,
      observationDir: input.observationDir,
      existingOutput: "REFUSED",
    },
    endpoints: {
      rpc: "SOLANA_RPC_URL: required, explicitly configured, https (configuration; never printed)",
      stream:
        "SOLANA_WS_URL: required, explicitly configured, wss; never derived from SOLANA_RPC_URL (configuration; never printed)",
    },
    budget: {
      sharedSessionLifetimeMs: L.session.lifetimeMs,
      lifetimeComposition: {
        acquisitionDurationMs: L.acquisition.durationMs,
        observationMs: L.owner.observationMs,
        unsubscribeAckTimeoutMs: L.owner.unsubscribeAckTimeoutMs,
        drainOrCleanupMs,
        requiredMs: requiredLifetimeMs,
        marginMs: L.session.lifetimeMs - requiredLifetimeMs,
        extended: false,
      },
      http: {
        maxHttpAttempts: L.session.maxHttpAttempts,
        acquisitionRequests: CPMM_ACQUISITION_REQUESTS,
        maxTransactionRetrievals: L.session.maxHttpAttempts - CPMM_ACQUISITION_REQUESTS,
        sharedBudgetReset: false,
        lane: "SOLANA_RPC",
        otherLaneAttempts: 0,
        retries: 0,
        perRequestTimeoutMs: L.session.requestTimeoutMs,
        acquisitionTimeoutMs: L.acquisition.timeoutMs,
        acquisitionDurationMs: L.acquisition.durationMs,
        solanaRpcPacingMs: L.session.lanes.SOLANA_RPC.pacingMs,
        maxOutstandingRetrievals: L.owner.maxOutstandingResolutions,
      },
      responses: {
        acquisitionMaxResponseBytes: L.acquisition.maxResponseBytes,
        solanaRpcMaxResponseBytes: L.session.lanes.SOLANA_RPC.maxResponseBytes,
        transactionAdapterMaxResponseBytes: L.adapter.maxResponseBytes,
        webSocketMaxFrameBytes: L.wrapper.maxFrameBytes,
        webSocketMaxEpochBytes: L.collector.maxEpochBytes,
        webSocketMaxEpochFrames: L.collector.maxEpochFrames,
      },
      connection: {
        connections: 1,
        subscriptions: 1,
        reconnects: 0,
        retries: 0,
        fallback: "NONE",
        handshakeTimeoutMs: L.wrapper.handshakeTimeoutMs,
        subscribeAckTimeoutMs: L.owner.ackTimeoutMs,
        pingIntervalMs: L.owner.pingIntervalMs,
        pongTimeoutMs: L.owner.pongTimeoutMs,
        maxPings: L.owner.maxPings,
        closeTimeoutMs: L.wrapper.closeTimeoutMs,
      },
      observation: {
        observationMs: L.owner.observationMs,
        unsubscribeAckTimeoutMs: L.owner.unsubscribeAckTimeoutMs,
        drainMs: L.owner.drainMs,
        cleanupTimeoutMs: L.owner.cleanupTimeoutMs,
      },
    },
    localOverhead: {
      network: "NONE",
      acquisitionEvidence: "SEALED_AND_VERIFIED_BEFORE_OBSERVATION_WITHIN_SESSION_LIFETIME",
      observationEvidence: "SEALED_AND_VERIFIED_AFTER_SESSION_SHUTDOWN",
      hardWallClockBound: false,
      description:
        "Sealing and verification are local file writes and offline re-derivation only, with no request or connection. The acquisition bundle is sealed and verified after the snapshot and before observation, while the shared session lifetime runs: that time uses the lifetime, and observation starts only if the remaining lifetime still covers the owner's ceiling. The observation bundle is sealed and verified after the session has shut down, outside the session lifetime. The data bounds below limit how much is written and read, not how long it takes: no hard wall-clock bound applies to local sealing and verification.",
      shutdownFallback: {
        graceMs: CPMM_OBSERVATION_SHUTDOWN_GRACE_MS,
        description:
          "Separate from the run: once the result is known the exit code is set and the process drains; only a process still alive this long afterwards is forced to exit with the same code. It does not bound sealing or verification, which finish before the result.",
      },
      dataBounds: {
        sanitizerMaxPayloadBytesPerFile: EVIDENCE_SANITIZER_LIMITS.maxPayloadBytes,
        verifierMaxManifestBytes: CPMM_EVIDENCE_VERIFIER_LIMITS.maxManifestBytes,
        verifierMaxFileBytes: CPMM_EVIDENCE_VERIFIER_LIMITS.maxFileBytes,
        verifierMaxTotalBytes: CPMM_EVIDENCE_VERIFIER_LIMITS.maxTotalBytes,
        verifierMaxEntries: CPMM_EVIDENCE_VERIFIER_LIMITS.maxEntries,
      },
    },
    componentVersions: CPMM_OBSERVATION_COMPONENT_VERSIONS,
    sequence: [
      "Validate arguments, the target and both new output directories before any configuration",
      "Resolve SOLANA_RPC_URL and SOLANA_WS_URL with the reviewed resolver; both explicit",
      "One accepted core run: acquire once, seal and verify; observe one connection only after ACQUIRED_REPRODUCED; seal and verify the observation bound to the acquisition",
      "Report the core's frozen result: execution, failures, requests, evidence and flags",
    ],
    boundaries: [
      "No discovery, target selection, retry, reconnect, fallback or automatic follow-up",
      "No purchase, order, position, strategy, admission, daemon or paper trading",
      "A failed seal is reported and never triggers reacquisition",
    ],
    flags: CPMM_EVIDENCE_FALSE_FLAGS,
  };
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A canonical base58 encoding of exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BASE58.indexOf(c));
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return zeros + bytes === 32;
}

/**
 * Refusals this entry point creates, with fixed text. Only these are printed as text: a
 * dependency's error is never trusted for its message, whatever prefix it carries.
 */
const trustedRefusals = new WeakSet<Error>();
function refusal(message: string): Error {
  const err = new Error(message);
  trustedRefusals.add(err);
  return Object.freeze(err);
}

const cliError = (message: string) => refusal(`[CLI_INVALID_ARG] ${message}`);

type Parsed =
  | { readonly mode: "HELP" }
  | { readonly mode: "VERIFY"; readonly observationDir: string; readonly acquisitionDir: string }
  | {
      readonly mode: "DRY_RUN" | "LIVE";
      readonly runId: string;
      readonly target: { readonly poolAddress: string; readonly candidateMint: string };
    };

function parseCli(rawArgs: readonly string[]): Parsed {
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        pool: { type: "string" },
        mint: { type: "string" },
        "run-id": { type: "string" },
        verify: { type: "string" },
        "acquisition-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch {
    // The parser's message can echo an argument; only fixed text is reported.
    throw cliError("unknown, malformed or positional argument");
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
  if (values.verify !== undefined || values["acquisition-dir"] !== undefined) {
    if (["live", "pool", "mint", "run-id"].some((k) => seen.has(k))) {
      throw cliError("--verify cannot be combined with --live, --pool, --mint or --run-id");
    }
    const observationDir = values.verify;
    const acquisitionDir = values["acquisition-dir"];
    if (typeof observationDir !== "string" || observationDir === "") {
      throw cliError("--verify needs the sealed observation directory");
    }
    if (typeof acquisitionDir !== "string" || acquisitionDir === "") {
      throw cliError("--verify needs --acquisition-dir with the acquisition directory");
    }
    return { mode: "VERIFY", observationDir, acquisitionDir };
  }
  const pool = values.pool;
  const mint = values.mint;
  const runId = values["run-id"];
  if (typeof pool !== "string" || typeof mint !== "string" || typeof runId !== "string") {
    throw cliError("--pool, --mint and --run-id are all required");
  }
  if (!isSolanaAddress(pool)) throw cliError("--pool must be a base58 account address");
  if (!isSolanaAddress(mint)) throw cliError("--mint must be a base58 account address");
  if (pool === mint) throw cliError("--pool and --mint must differ");
  if (!RUN_ID.test(runId)) {
    throw cliError(
      "--run-id must be letters, digits, '_' or '-' (up to 64, not starting with '_' or '-')",
    );
  }
  return {
    mode: values.live === true ? "LIVE" : "DRY_RUN",
    runId,
    target: { poolAddress: pool, candidateMint: mint },
  };
}

// ---------------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------------

const rel = (projectRoot: string, p: string) => {
  const r = path.relative(projectRoot, p);
  return (r === "" || r.startsWith("..") || path.isAbsolute(r) ? p : r).replace(/\\/g, "/");
};
const failureText = (f: { readonly stage: string; readonly code: string } | null) =>
  f === null ? null : `${f.stage}:${f.code}`;

function evidenceReport(
  projectRoot: string,
  a: {
    readonly acquisitionSeal: string;
    readonly acquisitionPath: string | null;
    readonly acquisition: CpmmPoolAcquisitionVerification | null;
    readonly observationSeal: string;
    readonly observationPath: string | null;
    readonly observation: CpmmEvidenceVerification | null;
  },
): CpmmObservationEvidenceReport {
  const acq = a.acquisition;
  const obs = a.observation;
  const tx = obs?.rederivation.components?.transactionAnalysis ?? null;
  return {
    acquisition: {
      path: a.acquisitionPath === null ? null : rel(projectRoot, a.acquisitionPath),
      seal: a.acquisitionSeal,
      manifestSha256: acq?.manifestSha256 ?? null,
      integrity: acq === null ? "NOT_VERIFIED" : acq.integrity,
      integrityCode: acq?.integrityCode ?? null,
      computed: acq?.computed ?? null,
    },
    observation: {
      path: a.observationPath === null ? null : rel(projectRoot, a.observationPath),
      seal: a.observationSeal,
      manifestSha256: obs?.manifestSha256 ?? null,
      integrity:
        obs === null ? null : { ok: obs.integrity.ok, problems: [...obs.integrity.problems] },
      retention:
        obs === null ? null : { status: obs.retention.status, reasons: [...obs.retention.reasons] },
      rederivation:
        obs === null
          ? null
          : {
              status: obs.rederivation.status,
              implementedComponents: obs.rederivation.implementedComponents,
              transactionAnalysis: tx?.analysis ?? null,
              transactionAnalysisUnavailableReason: tx?.unavailableReason ?? null,
            },
      acquisitionBinding: obs?.acquisitionBinding?.status ?? null,
      poolContextProvenance: obs?.poolContextProvenance ?? null,
    },
  };
}

/** Evidence that exists and does not verify, or that verifies only with limits. */
function evidenceState(e: CpmmObservationEvidenceReport): "NOT_VERIFIED" | "LIMITED" | "VERIFIED" {
  const a = e.acquisition;
  const o = e.observation;
  if (a.seal === "SEALED" && (a.integrity !== "VERIFIED" || a.computed === "MISMATCH"))
    return "NOT_VERIFIED";
  if (o.seal === "SEALED") {
    if (o.integrity === null || !o.integrity.ok) return "NOT_VERIFIED";
    if (o.acquisitionBinding !== "REPRODUCED") return "NOT_VERIFIED";
    if (o.rederivation?.implementedComponents === "MISMATCH") return "NOT_VERIFIED";
    if (
      o.retention?.status !== "COMPLETE" ||
      o.rederivation?.implementedComponents !== "REPRODUCED"
    )
      return "LIMITED";
  }
  return "VERIFIED";
}

const CANCELLED_CODE = /CANCELLED/;

/** The exit code of a live run, read from the core's frozen result only. */
export function cpmmObservationLiveExitCode(
  r: CpmmObservationRunResult,
  evidence: CpmmObservationEvidenceReport,
): number {
  const X = CPMM_OBSERVATION_EXIT_CODES;
  const cancelled =
    r.finalizationCancelled ||
    (r.firstFailure !== null && CANCELLED_CODE.test(r.firstFailure.code));
  if (r.firstFailure?.stage === "SETUP") return cancelled ? X.CANCELLED : X.INVALID;
  if (evidence.acquisition.seal !== "SEALED") return X.SEAL_FAILED;
  if (r.observation.started && evidence.observation.seal !== "SEALED") return X.SEAL_FAILED;
  const state = evidenceState(evidence);
  if (state === "NOT_VERIFIED") return X.EVIDENCE_NOT_VERIFIED;
  if (cancelled) return X.CANCELLED;
  if (r.status !== "SUCCEEDED") return X.RUN_FAILED;
  return state === "LIMITED" ? X.EVIDENCE_LIMITED : X.OK;
}

/** The exit code of `--verify`: about the evidence only, never the sealed run's outcome. */
export function cpmmObservationVerifyExitCode(evidence: CpmmObservationEvidenceReport): number {
  const X = CPMM_OBSERVATION_EXIT_CODES;
  const state = evidenceState(evidence);
  return state === "NOT_VERIFIED"
    ? X.EVIDENCE_NOT_VERIFIED
    : state === "LIMITED"
      ? X.EVIDENCE_LIMITED
      : X.OK;
}

const sealText = (s: { readonly ok: boolean; readonly code?: string } | null) =>
  s === null ? "NOT_SEALED" : s.ok ? "SEALED" : `FAILED:${s.code ?? "UNKNOWN"}`;

/**
 * The exit code of the process: the run's own code, except that a listener the entry point could
 * not remove turns a successful or limited run into a cleanup failure.
 */
export function cpmmObservationCliExitCode(
  runExitCode: number,
  signalCleanupFailures: readonly string[],
): number {
  const X = CPMM_OBSERVATION_EXIT_CODES;
  if (signalCleanupFailures.length === 0) return runExitCode;
  return runExitCode === X.OK || runExitCode === X.EVIDENCE_LIMITED
    ? X.CLEANUP_FAILED
    : runExitCode;
}

export function cpmmObservationReport(
  projectRoot: string,
  r: CpmmObservationRunResult,
  signalCleanupFailures: readonly string[] = [],
): CpmmObservationCliReport {
  const acqSeal = r.acquisitionEvidence.seal;
  const obsSeal = r.observationEvidence.seal;
  const window = (w: { readonly start: number; readonly end: number } | null) =>
    w === null ? 0 : w.end - w.start;
  return {
    execution: {
      status: r.status,
      firstFailure: failureText(r.firstFailure),
      clockFailure: failureText(r.clockFailure),
      finalizationCancelled: r.finalizationCancelled,
      cancelled:
        r.finalizationCancelled ||
        (r.firstFailure !== null && CANCELLED_CODE.test(r.firstFailure.code)),
      cleanupFailures: [...r.cleanupFailures],
      sessionStopReason: r.session.stopReason,
      ownerTerminalCause: r.observation.report?.terminal.cause ?? null,
      connectionRunClean: r.observation.report?.connectionRunClean ?? null,
    },
    requests: {
      httpAttempts: r.session.httpAttempts,
      acquisitionRequests: window(r.session.acquisitionWindow),
      observationRequests: window(r.session.observationWindow),
      webSocketConnections: r.observation.transportFactoryCalls,
    },
    evidence: evidenceReport(projectRoot, {
      acquisitionSeal: sealText(acqSeal),
      acquisitionPath: acqSeal?.ok ? acqSeal.outDir : null,
      acquisition: r.acquisitionEvidence.verification,
      observationSeal: sealText(obsSeal),
      observationPath: obsSeal?.ok ? obsSeal.outDir : null,
      observation: r.observationEvidence.verification,
    }),
    flags: CPMM_EVIDENCE_FALSE_FLAGS,
    entryPoint: { signalCleanupFailures: [...signalCleanupFailures] },
  };
}

function logEvidence(log: (line: string) => void, p: string, e: CpmmObservationEvidenceReport) {
  const a = e.acquisition;
  const o = e.observation;
  log(`[${p}] Acquisition bundle: ${a.path ?? "none"} (${a.seal})`);
  log(
    `[${p}] Acquisition integrity: ${a.integrity}${a.integrityCode ? ` (${a.integrityCode})` : ""}; computed: ${a.computed ?? "NOT_EVALUATED"}`,
  );
  log(`[${p}] Observation bundle: ${o.path ?? "none"} (${o.seal})`);
  log(
    `[${p}] Observation integrity: ${o.integrity === null ? "NOT_VERIFIED" : o.integrity.ok ? "OK" : `FAILED (${o.integrity.problems.join(", ")})`}`,
  );
  log(
    `[${p}] Retention: ${o.retention === null ? "NOT_EVALUATED" : `${o.retention.status}${o.retention.reasons.length ? ` (${o.retention.reasons.join(", ")})` : ""}`}`,
  );
  const d = o.rederivation;
  log(
    `[${p}] Re-derivation: ${d === null ? "NOT_ATTEMPTED" : `${d.status}; implemented components ${d.implementedComponents ?? "NOT_EVALUATED"}; transaction analysis ${d.transactionAnalysis ?? "NOT_EVALUATED"}${d.transactionAnalysisUnavailableReason ? ` (${d.transactionAnalysisUnavailableReason})` : ""}`}`,
  );
  log(`[${p}] Acquisition binding: ${o.acquisitionBinding ?? "NOT_EVALUATED"}`);
}

const FLAGS_LINE = (p: string) =>
  `[${p}] Qualification flags (all false): ${Object.keys(CPMM_EVIDENCE_FALSE_FLAGS).join(", ")}`;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const CPMM_OBSERVATION_CONFIG_ERRORS = Object.freeze({
  wsExplicit:
    "[MISSING_CONFIGURATION] SOLANA_WS_URL (wss) must be configured explicitly for --live; it is never derived from SOLANA_RPC_URL",
  rpcHttps: "[INVALID_CONFIGURATION] SOLANA_RPC_URL must use https for --live",
  fragment: "[INVALID_CONFIGURATION] SOLANA_RPC_URL and SOLANA_WS_URL must not contain a fragment",
});

/** Fixed refusals for a failing dependency: its own error text is withheld. */
export const CPMM_OBSERVATION_DEPENDENCY_ERRORS = Object.freeze({
  configurationLoad:
    "[CONFIGURATION_LOAD_FAILED] the configuration loader failed; its error text is withheld",
  endpointRefused: "[INVALID_CONFIGURATION] the endpoint resolver refused the configuration",
  webSocketClientLoad:
    "[WS_CLIENT_LOAD_FAILED] the WebSocket client could not be loaded; its error text is withheld",
  signalInstall:
    "[SIGNAL_INSTALL_FAILED] a signal listener could not be installed; the run did not start",
});

export const printableError = (err: unknown): string =>
  err instanceof Error && trustedRefusals.has(err) ? err.message : "[UNEXPECTED_ERROR]";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const defaultTimers: PaperRequestSessionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function loadInstalledWebSocket(): Promise<CpmmWsClientConstructor> {
  const { default: WebSocket } = await import("ws");
  const ctor: CpmmWsClientConstructor = WebSocket;
  return ctor;
}

async function loadConfiguredEnvironment(): Promise<void> {
  (await import("./paper-trading-daemon.js")).loadDaemonEnvironment();
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function runCpmmPoolObservationCli(
  rawArgs: readonly string[],
  deps: CpmmObservationCliDeps = {},
): Promise<CpmmObservationCliResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const parsed = parseCli(rawArgs);
  const X = CPMM_OBSERVATION_EXIT_CODES;

  if (parsed.mode === "HELP") {
    const planJson = JSON.stringify(
      buildCpmmObservationPlan({
        mode: "DRY_RUN",
        runId: "<run id>",
        target: { poolAddress: "<pool address>", candidateMint: "<candidate mint>" },
        acquisitionDir: `${CPMM_ACQUISITION_ROOT_SEGMENTS.join("/")}/<run id>`,
        observationDir: `${CPMM_EVIDENCE_ROOT_SEGMENTS.join("/")}/<run id>`,
      }),
    );
    log(CPMM_OBSERVATION_USAGE);
    log("[HELP] No configuration loaded, no transport opened, no request sent, nothing written.");
    log(planJson);
    return { mode: "HELP", exitCode: X.OK, planDigestSha256: sha256(planJson) };
  }

  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());

  if (parsed.mode === "VERIFY") {
    const observationDir = path.resolve(projectRoot, parsed.observationDir);
    const acquisitionDir = path.resolve(projectRoot, parsed.acquisitionDir);
    const acquisition = verifyCpmmPoolAcquisitionEvidence(acquisitionDir);
    const observation = verifyCpmmObservationEvidence(observationDir, { acquisitionDir });
    const report = evidenceReport(projectRoot, {
      acquisitionSeal: "SEALED",
      acquisitionPath: acquisitionDir,
      acquisition,
      observationSeal: "SEALED",
      observationPath: observationDir,
      observation,
    });
    log("[VERIFY] Offline and read-only: no configuration or credential loaded, nothing written.");
    logEvidence(log, "VERIFY", report);
    log(
      "[VERIFY] Limitation: without the run's credentials, transaction responses are not re-analysed; their decoded outcomes are not reproduced here.",
    );
    log(FLAGS_LINE("VERIFY"));
    return {
      mode: "VERIFY",
      exitCode: cpmmObservationVerifyExitCode(report),
      verification: report,
    };
  }

  const acquisitionDir = path.join(projectRoot, ...CPMM_ACQUISITION_ROOT_SEGMENTS, parsed.runId);
  const observationDir = path.join(projectRoot, ...CPMM_EVIDENCE_ROOT_SEGMENTS, parsed.runId);
  for (const dir of [acquisitionDir, observationDir]) {
    if (existsSync(dir)) {
      throw refusal(
        `[OUTPUT_EXISTS] ${rel(projectRoot, dir)} already exists; refusing to overwrite`,
      );
    }
  }
  const planJson = JSON.stringify(
    buildCpmmObservationPlan({
      mode: parsed.mode,
      runId: parsed.runId,
      target: parsed.target,
      acquisitionDir: rel(projectRoot, acquisitionDir),
      observationDir: rel(projectRoot, observationDir),
    }),
  );
  const planDigestSha256 = sha256(planJson);
  if (parsed.mode === "DRY_RUN") {
    log(
      "[DRY_RUN] No configuration loaded, no transport opened, no request sent, nothing written.",
    );
    log(
      `[DRY_RUN] Profile: ${CPMM_OBSERVATION_PROFILE_LABEL} (${CPMM_OBSERVATION_PROFILE_STATUS})`,
    );
    log(`[DRY_RUN] Live execution: ${CPMM_OBSERVATION_LIVE_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode: "DRY_RUN", exitCode: X.OK, planDigestSha256 };
  }

  // ------------------------------------------------------------------------------------------
  // --live: configuration is loaded only here, after every argument and output check.
  // ------------------------------------------------------------------------------------------
  const D = CPMM_OBSERVATION_DEPENDENCY_ERRORS;
  try {
    await (deps.loadEnvironment ?? loadConfiguredEnvironment)();
  } catch {
    throw refusal(D.configurationLoad);
  }
  const env = deps.env ?? process.env;
  const { resolveSolanaEndpoints, SOLANA_ENDPOINT_ERRORS } =
    await import("./paper-single-candidate-diagnostic.js");
  const endpoints = resolveSolanaEndpoints(env);
  if (!endpoints.ok) {
    const known: readonly string[] = Object.values(SOLANA_ENDPOINT_ERRORS);
    throw refusal(known.includes(endpoints.error) ? endpoints.error : D.endpointRefused);
  }
  if (endpoints.wsSource !== "SOLANA_WS_URL")
    throw refusal(CPMM_OBSERVATION_CONFIG_ERRORS.wsExplicit);
  // With an https RPC endpoint the resolver already refuses any explicit stream URL but wss.
  if (new URL(endpoints.rpcUrl).protocol !== "https:")
    throw refusal(CPMM_OBSERVATION_CONFIG_ERRORS.rpcHttps);
  if (endpoints.rpcUrl.includes("#") || endpoints.wsUrl.includes("#"))
    throw refusal(CPMM_OBSERVATION_CONFIG_ERRORS.fragment);

  // Real transport dependencies are loaded only after every check above.
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  let webSocketClientConstructor: CpmmWsClientConstructor;
  try {
    webSocketClientConstructor = await (deps.loadWebSocketConstructor ?? loadInstalledWebSocket)();
  } catch {
    throw refusal(D.webSocketClientLoad);
  }

  log(`[LIVE] Profile: ${CPMM_OBSERVATION_PROFILE_LABEL} (${CPMM_OBSERVATION_PROFILE_STATUS})`);
  log(`[LIVE] ${CPMM_OBSERVATION_LIVE_FLAG_MEANING}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);

  const signals = deps.signals ?? process;
  const controller = new AbortController();
  // A listener the source fails to remove may stay attached; it must do nothing after the run.
  let listening = true;
  const listeners = new Map(
    CPMM_OBSERVATION_SIGNALS.map((s) => [
      s,
      () => {
        if (!listening || controller.signal.aborted) return;
        log(`[LIVE] ${s} received: cancelling the run; the core still seals what it has`);
        controller.abort();
      },
    ]),
  );
  // Recorded before each registration: one that attaches and then throws is still removed.
  const attempted: CpmmObservationSignal[] = [];
  const signalCleanupFailures: string[] = [];
  let installFailed = false;
  let result: CpmmObservationRunResult | null = null;
  try {
    try {
      for (const s of CPMM_OBSERVATION_SIGNALS) {
        attempted.push(s);
        signals.on(s, listeners.get(s)!);
      }
    } catch {
      installFailed = true;
    }
    if (!installFailed)
      result = await runCpmmPoolObservation({
        projectRoot,
        runId: parsed.runId,
        target: { ...parsed.target },
        endpoints: { rpcUrl: endpoints.rpcUrl, streamUrl: endpoints.wsUrl },
        secrets: [],
        fetchFn,
        webSocketClientConstructor,
        clock: deps.clock ?? (() => Date.now()),
        timers: deps.timers ?? defaultTimers,
        signal: controller.signal,
        componentVersions: { ...CPMM_OBSERVATION_COMPONENT_VERSIONS },
        epoch: CPMM_OBSERVATION_RUN_CONSTANTS.epoch,
        subscribeRequestId: CPMM_OBSERVATION_RUN_CONSTANTS.subscribeRequestId,
        unsubscribeRequestId: CPMM_OBSERVATION_RUN_CONSTANTS.unsubscribeRequestId,
        limits: L,
      });
  } finally {
    listening = false;
    for (const s of attempted) {
      try {
        signals.removeListener(s, listeners.get(s)!);
      } catch {
        signalCleanupFailures.push(`SIGNAL_REMOVE_FAILED:${s}`);
      }
    }
  }
  if (installFailed || result === null) {
    throw refusal(
      signalCleanupFailures.length === 0
        ? D.signalInstall
        : `${D.signalInstall}; listener cleanup failed: ${signalCleanupFailures.join(", ")}`,
    );
  }

  const report = cpmmObservationReport(projectRoot, result, signalCleanupFailures);
  const exitCode = cpmmObservationCliExitCode(
    cpmmObservationLiveExitCode(result, report.evidence),
    signalCleanupFailures,
  );
  const e = report.execution;
  log(`[LIVE] Execution: ${e.status}; first failure: ${e.firstFailure ?? "none"}`);
  log(
    `[LIVE] Clock failure: ${e.clockFailure ?? "none"}; cancelled: ${e.cancelled ? "yes" : "no"} (at finalization: ${e.finalizationCancelled ? "yes" : "no"})`,
  );
  log(
    `[LIVE] Cleanup failures: ${e.cleanupFailures.length ? e.cleanupFailures.join(", ") : "none"}`,
  );
  const cleanup = report.entryPoint.signalCleanupFailures;
  log(`[LIVE] Entry-point cleanup failures: ${cleanup.length ? cleanup.join(", ") : "none"}`);
  log(
    `[LIVE] Session stop: ${e.sessionStopReason ?? "none"}; owner terminal cause: ${e.ownerTerminalCause ?? "not started"}`,
  );
  const q = report.requests;
  log(
    `[LIVE] Requests: ${q.httpAttempts} HTTP (${q.acquisitionRequests} acquisition, ${q.observationRequests} transaction retrieval); WebSocket connections: ${q.webSocketConnections}`,
  );
  logEvidence(log, "LIVE", report.evidence);
  log(FLAGS_LINE("LIVE"));
  log(`[LIVE] Exit code ${exitCode}. Ends here: no follow-up, retry or reacquisition.`);
  log(JSON.stringify(report));
  return { mode: "LIVE", exitCode, planDigestSha256, report };
}

/** Settles the process with the shutdown backstop (`CPMM_OBSERVATION_SHUTDOWN_GRACE_MS`). */
export function settleCpmmObservationProcess(
  exitCode: number,
  graceMs: number = CPMM_OBSERVATION_SHUTDOWN_GRACE_MS,
): void {
  process.exitCode = exitCode;
  const backstop = setTimeout(() => {
    console.error(CPMM_OBSERVATION_SHUTDOWN_FORCED_NOTICE, `after ${graceMs} ms`);
    process.exit(exitCode);
  }, graceMs);
  backstop.unref();
}

/**
 * A file's identity: its real path, or null if it cannot be resolved. The native resolver also
 * returns the on-disk case and separators on Windows, so differently spelled paths agree.
 */
function fileIdentity(file: string): string | null {
  try {
    return realpathSync.native(path.resolve(file));
  } catch {
    return null;
  }
}

/**
 * Whether the process was started with this file as its entry point. A file elsewhere with the
 * same name that imports this module is not this file, so importing never runs the CLI.
 */
export function isCpmmObservationMainModule(
  entryArg: string | undefined,
  moduleUrl: string,
): boolean {
  if (entryArg === undefined || entryArg === "") return false;
  const entry = fileIdentity(entryArg);
  return entry !== null && entry === fileIdentity(fileURLToPath(moduleUrl));
}

if (isCpmmObservationMainModule(process.argv[1], import.meta.url)) {
  runCpmmPoolObservationCli(process.argv.slice(2))
    .then((r) => settleCpmmObservationProcess(r.exitCode))
    .catch((err: unknown) => {
      console.error("[CPMM_POOL_OBSERVATION_ERROR]", printableError(err));
      settleCpmmObservationProcess(CPMM_OBSERVATION_EXIT_CODES.INVALID);
    });
}
