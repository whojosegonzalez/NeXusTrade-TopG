/**
 * Roadmap step 3 (assessment §8.38.17 item 17 T): the offline composition core of one CPMM pool
 * observation run. Not wired: no CLI, environment, credential file, default limit or provider.
 *
 * One call composes the accepted components through their public interfaces over one injected
 * `PaperRequestSession` (one budget, one paced SOLANA_RPC lane, never reset): it acquires the
 * pool and vault accounts once, seals and verifies that acquisition, and only after
 * `ACQUIRED_REPRODUCED` lets the connection owner run one bounded connection. It then finishes the
 * recorder, seals the observation with the acquisition as its exact dependency and verifies both
 * offline. Endpoints, fetch, the WebSocket client constructor, clock, timers, cancellation and
 * every limit are supplied by the caller. Nothing here establishes notification completeness, a
 * quiet window, a replayable capture, qualification or admission.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import {
  CpmmPoolAccountAcquisition,
  type CpmmPoolAccountAcquisitionResult,
} from "../candidate-scanner/CpmmPoolAccountAcquisition.js";
import {
  CpmmPoolConnectionOwner,
  type CpmmConnectionOwnerLimits,
  type CpmmConnectionRunReport,
  type CpmmOwnerTransport,
} from "../candidate-scanner/CpmmPoolConnectionOwner.js";
import {
  CpmmPoolNotificationCollector,
  type CpmmCollectorLimits,
} from "../candidate-scanner/CpmmPoolNotificationCollector.js";
import {
  CPMM_OBSERVATION_RECORDER_LIMIT_KEYS,
  createCpmmPoolObservationRecorder,
  createExchangeObserverFanOut,
  type CpmmObservationRecorderLimits,
  type CpmmObservationSnapshot,
} from "../candidate-scanner/CpmmPoolObservationRecorder.js";
import {
  CpmmPoolWebSocketTransport,
  type CpmmPoolWebSocketTransportLimits,
  type CpmmWsClientConstructor,
} from "../candidate-scanner/CpmmPoolWebSocketTransport.js";
import {
  CpmmResolutionAccountingLedger,
  type CpmmLedgerLimits,
} from "../candidate-scanner/CpmmResolutionAccountingLedger.js";
import {
  MIN_SOLANA_RPC_PACING_MS,
  PAPER_REQUEST_LANES,
  PaperRequestSession,
  validatePaperRequestSessionLimits,
  type PaperRequestLane,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import {
  CPMM_MIN_SECRET_CHARS,
  RaydiumCpmmTransactionSourceAdapter,
  createCpmmExchangeEvidenceRecorder,
} from "../candidate-scanner/RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "../candidate-scanner/RollingTradeFlowTracker.js";
import {
  sealCpmmPoolAcquisitionEvidence,
  verifyCpmmPoolAcquisitionEvidence,
  type CpmmPoolAcquisitionVerification,
} from "./cpmm-pool-acquisition-evidence.js";
import {
  CPMM_COMPONENT_VERSION_KEYS,
  CPMM_EVIDENCE_FALSE_FLAGS,
  CPMM_EVIDENCE_ROOT_SEGMENTS,
  sealCpmmObservationEvidence,
  verifyCpmmObservationEvidence,
  type CpmmEvidenceVerification,
  type SealCpmmObservationResult,
} from "./cpmm-pool-observation-evidence.js";

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

/** Where the acquisition sealer writes (`<projectRoot>/data/research/cpmm-acquisitions/<runId>`). */
export const CPMM_ACQUISITION_ROOT_SEGMENTS: readonly string[] = Object.freeze([
  "data",
  "research",
  "cpmm-acquisitions",
]);
/** The run's own session stop reasons (the session keeps the first cause). */
export const CPMM_RUN_STOP_FINISHED = "CPMM_OBSERVATION_RUN_FINISHED" as const;
export const CPMM_RUN_STOP_ABANDONED = "CPMM_OBSERVATION_RUN_ABANDONED" as const;

/** The acquisition's own ceilings (`CpmmPoolAccountAcquisition`). */
const ACQUISITION_MAX_DURATION_MS = 30_000;
const ACQUISITION_MAX_TIMEOUT_MS = 10_000;
const ACQUISITION_MAX_RESPONSE_BYTES = 16_384;
/** Two acquisition requests and at least one transaction retrieval. */
const MIN_RUN_ATTEMPTS = 3;
const MAX_SECRETS = 16;
const INT32_MAX = 2_147_483_647;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

export interface CpmmObservationRunLimits {
  readonly session: PaperRequestSessionLimits;
  readonly acquisition: {
    /** From the acquisition's start to its absolute deadline. */
    readonly durationMs: number;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
  };
  readonly owner: CpmmConnectionOwnerLimits;
  readonly wrapper: CpmmPoolWebSocketTransportLimits;
  readonly collector: CpmmCollectorLimits;
  readonly ledger: CpmmLedgerLimits;
  readonly adapter: { readonly maxTrackedSignatures: number; readonly maxResponseBytes: number };
  readonly evidenceRecorder: { readonly maxPendingEvidence: number };
  readonly recorder: CpmmObservationRecorderLimits;
  readonly fanOut: { readonly maxRetainedFailures: number };
}

export interface CpmmObservationRunOptions {
  /** Absolute; both bundles are written under it. */
  readonly projectRoot: string;
  /** Used for both bundles. */
  readonly runId: string;
  readonly target: { readonly poolAddress: string; readonly candidateMint: string };
  /** Opaque and credential-bearing; never retained in a result or written. */
  readonly endpoints: { readonly rpcUrl: string; readonly streamUrl: string };
  /** Further credential values (printable ASCII); redacted from evidence, used for analysis. */
  readonly secrets: readonly string[];
  readonly fetchFn: typeof fetch;
  readonly webSocketClientConstructor: CpmmWsClientConstructor;
  readonly clock: () => number;
  readonly timers: PaperRequestSessionTimers;
  readonly signal?: AbortSignal;
  /** Commit identifiers of the accepted components, recorded in the observation manifest. */
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly epoch: number;
  readonly subscribeRequestId: number;
  readonly unsubscribeRequestId: number;
  readonly limits: CpmmObservationRunLimits;
}

export type CpmmObservationRunStage =
  | "SETUP"
  | "ACQUISITION"
  | "ACQUISITION_EVIDENCE"
  | "STAGE_BOUNDARY"
  | "OBSERVATION"
  | "RECORDING"
  | "OBSERVATION_EVIDENCE";

export type CpmmAcquisitionSealResult = ReturnType<typeof sealCpmmPoolAcquisitionEvidence>;

export interface CpmmObservationRunResult {
  readonly kind: "CPMM_POOL_OBSERVATION_RUN_RESULT";
  readonly version: 1;
  /** SUCCEEDED only with no failure and no cleanup failure; never upgraded later. */
  readonly status: "SUCCEEDED" | "FAILED";
  /** The first failure in lifecycle order (fixed codes only); never replaced by a later one. */
  readonly firstFailure: { readonly stage: CpmmObservationRunStage; readonly code: string } | null;
  /** Kept apart from the first failure and from the owner's terminal cause. */
  readonly cleanupFailures: readonly string[];
  readonly acquisition: {
    readonly outcome: CpmmPoolAccountAcquisitionResult["outcome"];
    readonly code: string;
    readonly stage: CpmmPoolAccountAcquisitionResult["stage"];
    readonly sessionStopReason: string | null;
    readonly retainedExchanges: number;
  } | null;
  readonly acquisitionEvidence: {
    readonly seal: CpmmAcquisitionSealResult | null;
    readonly verification: CpmmPoolAcquisitionVerification | null;
  };
  readonly observation: {
    /** The owner was constructed and run. */
    readonly started: boolean;
    readonly transportFactoryCalls: number;
    /** The owner's settled report (credential-free). */
    readonly report: CpmmConnectionRunReport | null;
  };
  /** Whether recorder.finish() produced a snapshot (the snapshot itself is never returned). */
  readonly recording: { readonly finished: boolean };
  readonly observationEvidence: {
    readonly seal: SealCpmmObservationResult | null;
    readonly verification: CpmmEvidenceVerification | null;
  };
  readonly session: {
    /** The session's own first stop reason, as read at the end. */
    readonly stopReason: string | null;
    readonly httpAttempts: number;
    readonly acquisitionWindow: { readonly start: number; readonly end: number } | null;
    readonly observationWindow: { readonly start: number; readonly end: number } | null;
  };
  readonly flags: typeof CPMM_EVIDENCE_FALSE_FLAGS;
}

// ---------------------------------------------------------------------------------------------
// Validation (before anything is constructed)
// ---------------------------------------------------------------------------------------------

class RunRefusal extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function refuse(code: string): never {
  throw new RunRefusal(code);
}

/** Exact plain data: own data properties only, no getter or proxy is ever invoked. */
function data(
  value: unknown,
  required: readonly string[],
  code: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value))
    refuse(code);
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) refuse(code);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      refuse(code);
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d)) refuse(code);
    out[key] = d.value as unknown;
  }
  for (const key of required) if (!(key in out)) refuse(code);
  return out;
}

function ints<K extends string>(
  value: unknown,
  keys: readonly K[],
  code: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): Readonly<Record<K, number>> {
  const r = data(value, keys, code);
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const n = r[k];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) refuse(code);
    out[k] = n;
  }
  return Object.freeze(out);
}

function fn(value: unknown, code: string): void {
  if (typeof value !== "function" || types.isProxy(value)) refuse(code);
}

function strings(value: unknown, code: string, max: number): string[] {
  if (!Array.isArray(value) || types.isProxy(value)) refuse(code);
  const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
  if (length > max || Reflect.ownKeys(value).length !== length + 1) refuse(code);
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || typeof d.value !== "string") refuse(code);
    out.push(d.value as string);
  }
  return out;
}

const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const aborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && (getAborted.call(signal) as boolean);

function url(value: unknown, protocol: "https:" | "wss:", code: string): string {
  if (typeof value !== "string") refuse(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse(code);
  }
  if (parsed.protocol !== protocol || parsed.hash !== "" || value.includes("#")) refuse(code);
  return value;
}

const OWNER_KEYS = [
  "observationMs",
  "ackTimeoutMs",
  "unsubscribeAckTimeoutMs",
  "pingIntervalMs",
  "pongTimeoutMs",
  "maxPings",
  "maxPongReplies",
  "maxControlFrames",
  "maxControlPayloadBytes",
  "maxOutstandingResolutions",
  "maxRetainedUnprocessed",
  "drainMs",
  "cleanupTimeoutMs",
] as const;
const WRAPPER_KEYS = [
  "maxFrameBytes",
  "maxFragments",
  "maxBufferedChunks",
  "handshakeTimeoutMs",
  "closeTimeoutMs",
] as const;
const COLLECTOR_KEYS = [
  "maxFrameBytes",
  "maxEpochFrames",
  "maxEpochBytes",
  "maxRetainedFrameRecords",
  "maxRetainedNotifications",
  "maxEpochs",
] as const;
const LEDGER_KEYS = ["maxSignatureRecords", "maxDuplicateDetailsPerRecord", "maxEpochs"] as const;

/** The owner's start ceiling relative to its start (item 15): intake end plus drain or cleanup. */
const ownerCeilingMs = (o: CpmmConnectionOwnerLimits): number =>
  o.observationMs + o.unsubscribeAckTimeoutMs + Math.max(o.drainMs, o.cleanupTimeoutMs);

interface Validated {
  readonly projectRoot: string;
  readonly runId: string;
  readonly target: { readonly poolAddress: string; readonly candidateMint: string };
  readonly rpcUrl: string;
  readonly streamUrl: string;
  /** The adapter's `secrets` and the verifier's `analysisSecrets`. */
  readonly analysisSecrets: readonly string[];
  readonly credentials: {
    readonly urls: readonly string[];
    readonly additional: readonly string[];
  };
  readonly fetchFn: typeof fetch;
  readonly ctor: CpmmWsClientConstructor;
  readonly clock: () => number;
  readonly timers: PaperRequestSessionTimers;
  readonly signal: AbortSignal | undefined;
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly epoch: number;
  readonly subscribeRequestId: number;
  readonly unsubscribeRequestId: number;
  readonly limits: CpmmObservationRunLimits;
}

function validate(options: unknown): Validated {
  const o = data(
    options,
    [
      "projectRoot",
      "runId",
      "target",
      "endpoints",
      "secrets",
      "fetchFn",
      "webSocketClientConstructor",
      "clock",
      "timers",
      "componentVersions",
      "epoch",
      "subscribeRequestId",
      "unsubscribeRequestId",
      "limits",
    ],
    "OPTIONS_INVALID",
    ["signal"],
  );
  if (typeof o.projectRoot !== "string" || !path.isAbsolute(o.projectRoot))
    refuse("PROJECT_ROOT_INVALID");
  if (typeof o.runId !== "string" || !RUN_ID.test(o.runId)) refuse("RUN_ID_INVALID");
  const t = data(o.target, ["poolAddress", "candidateMint"], "TARGET_INVALID");
  if (typeof t.poolAddress !== "string" || typeof t.candidateMint !== "string")
    refuse("TARGET_INVALID");
  const e = data(o.endpoints, ["rpcUrl", "streamUrl"], "ENDPOINTS_INVALID");
  const rpcUrl = url(e.rpcUrl, "https:", "ENDPOINTS_INVALID");
  const streamUrl = url(e.streamUrl, "wss:", "ENDPOINTS_INVALID");
  const secrets = strings(o.secrets, "SECRETS_INVALID", MAX_SECRETS);
  if (secrets.some((s) => s.length < CPMM_MIN_SECRET_CHARS || !PRINTABLE.test(s)))
    refuse("SECRETS_INVALID");
  fn(o.fetchFn, "FETCH_INVALID");
  fn(o.webSocketClientConstructor, "WEBSOCKET_CONSTRUCTOR_INVALID");
  fn(o.clock, "CLOCK_INVALID");
  const timers = data(o.timers, ["setTimeout", "clearTimeout"], "TIMERS_INVALID");
  fn(timers.setTimeout, "TIMERS_INVALID");
  fn(timers.clearTimeout, "TIMERS_INVALID");
  let signal: AbortSignal | undefined;
  if (o.signal !== undefined) {
    if (
      typeof o.signal !== "object" ||
      o.signal === null ||
      types.isProxy(o.signal) ||
      Object.getPrototypeOf(o.signal) !== AbortSignal.prototype
    )
      refuse("SIGNAL_INVALID");
    signal = o.signal as AbortSignal;
    try {
      aborted(signal);
    } catch {
      refuse("SIGNAL_INVALID");
    }
  }
  const versions = data(o.componentVersions, CPMM_COMPONENT_VERSION_KEYS, "COMPONENT_VERSIONS");
  for (const k of CPMM_COMPONENT_VERSION_KEYS) {
    if (typeof versions[k] !== "string" || !COMMIT.test(versions[k] as string))
      refuse("COMPONENT_VERSIONS_INVALID");
  }
  for (const k of ["epoch", "subscribeRequestId", "unsubscribeRequestId"] as const) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) refuse("REQUEST_IDS_INVALID");
  }
  if (o.subscribeRequestId === o.unsubscribeRequestId) refuse("REQUEST_IDS_INVALID");

  const limits = readLimits(o.limits);
  const root = o.projectRoot;
  for (const [name, segments] of [
    ["ACQUISITION", CPMM_ACQUISITION_ROOT_SEGMENTS],
    ["OBSERVATION", CPMM_EVIDENCE_ROOT_SEGMENTS],
  ] as const) {
    if (existsSync(path.join(root, ...segments, o.runId))) refuse(`OUTPUT_EXISTS:${name}`);
  }
  const frozenTimers: PaperRequestSessionTimers = Object.freeze({
    setTimeout: timers.setTimeout as PaperRequestSessionTimers["setTimeout"],
    clearTimeout: timers.clearTimeout as PaperRequestSessionTimers["clearTimeout"],
  });
  return Object.freeze({
    projectRoot: root,
    runId: o.runId,
    target: Object.freeze({ poolAddress: t.poolAddress, candidateMint: t.candidateMint }),
    rpcUrl,
    streamUrl,
    analysisSecrets: Object.freeze([rpcUrl, ...secrets]),
    credentials: Object.freeze({
      urls: Object.freeze([rpcUrl, streamUrl]),
      additional: Object.freeze([...secrets]),
    }),
    fetchFn: o.fetchFn as typeof fetch,
    ctor: o.webSocketClientConstructor as CpmmWsClientConstructor,
    clock: o.clock as () => number,
    timers: frozenTimers,
    signal,
    componentVersions: Object.freeze(
      Object.fromEntries(CPMM_COMPONENT_VERSION_KEYS.map((k) => [k, versions[k] as string])),
    ),
    epoch: o.epoch as number,
    subscribeRequestId: o.subscribeRequestId as number,
    unsubscribeRequestId: o.unsubscribeRequestId as number,
    limits,
  });
}

function readLimits(value: unknown): CpmmObservationRunLimits {
  const l = data(
    value,
    [
      "session",
      "acquisition",
      "owner",
      "wrapper",
      "collector",
      "ledger",
      "adapter",
      "evidenceRecorder",
      "recorder",
      "fanOut",
    ],
    "LIMITS_INVALID",
  );
  const s = data(
    l.session,
    ["lifetimeMs", "maxHttpAttempts", "requestTimeoutMs", "lanes"],
    "LIMITS_INVALID:SESSION",
  );
  const laneRecord = data(s.lanes, PAPER_REQUEST_LANES, "LIMITS_INVALID:SESSION");
  const lanes = {} as Record<PaperRequestLane, Readonly<Record<string, number>>>;
  for (const lane of PAPER_REQUEST_LANES) {
    const r = data(
      laneRecord[lane],
      ["maxAttempts", "pacingMs", "maxResponseBytes"],
      "LIMITS_INVALID:SESSION",
    );
    if (typeof r.maxAttempts !== "number" || !Number.isSafeInteger(r.maxAttempts))
      refuse("LIMITS_INVALID:SESSION");
    lanes[lane] = Object.freeze({
      maxAttempts: r.maxAttempts,
      ...ints(
        { pacingMs: r.pacingMs, maxResponseBytes: r.maxResponseBytes },
        ["pacingMs", "maxResponseBytes"],
        "LIMITS_INVALID:SESSION",
      ),
    });
  }
  let session: PaperRequestSessionLimits;
  try {
    session = validatePaperRequestSessionLimits({
      lifetimeMs: s.lifetimeMs,
      maxHttpAttempts: s.maxHttpAttempts,
      requestTimeoutMs: s.requestTimeoutMs,
      lanes,
    });
  } catch {
    return refuse("LIMITS_INVALID:SESSION");
  }
  const rpc = session.lanes.SOLANA_RPC;
  if (rpc.pacingMs < MIN_SOLANA_RPC_PACING_MS) refuse("LIMITS_INVALID:RPC_PACING");
  if (session.maxHttpAttempts < MIN_RUN_ATTEMPTS || rpc.maxAttempts < MIN_RUN_ATTEMPTS)
    refuse("LIMITS_INVALID:ATTEMPTS");
  if (
    PAPER_REQUEST_LANES.some(
      (lane) => lane !== "SOLANA_RPC" && session.lanes[lane].maxAttempts !== 0,
    )
  )
    refuse("LIMITS_INVALID:OTHER_LANES_ENABLED");

  const acquisition = ints(
    l.acquisition,
    ["durationMs", "timeoutMs", "maxResponseBytes"],
    "LIMITS_INVALID:ACQUISITION",
  );
  if (
    acquisition.durationMs > ACQUISITION_MAX_DURATION_MS ||
    acquisition.timeoutMs >
      Math.min(ACQUISITION_MAX_TIMEOUT_MS, session.requestTimeoutMs, acquisition.durationMs) ||
    acquisition.maxResponseBytes > Math.min(ACQUISITION_MAX_RESPONSE_BYTES, rpc.maxResponseBytes)
  )
    refuse("LIMITS_INVALID:ACQUISITION");

  const owner = ints(l.owner, OWNER_KEYS, "LIMITS_INVALID:OWNER") as CpmmConnectionOwnerLimits;
  if (
    owner.ackTimeoutMs >= owner.observationMs ||
    owner.pongTimeoutMs >= owner.pingIntervalMs ||
    owner.maxPings < Math.ceil(owner.observationMs / owner.pingIntervalMs) ||
    owner.maxControlPayloadBytes < 8 ||
    owner.maxControlPayloadBytes > 125
  )
    refuse("LIMITS_INVALID:OWNER");
  const wrapper = ints(
    l.wrapper,
    WRAPPER_KEYS,
    "LIMITS_INVALID:WRAPPER",
    1,
    INT32_MAX,
  ) as CpmmPoolWebSocketTransportLimits;
  const collector = ints(
    l.collector,
    COLLECTOR_KEYS,
    "LIMITS_INVALID:COLLECTOR",
  ) as CpmmCollectorLimits;
  const ledger = ints(l.ledger, LEDGER_KEYS, "LIMITS_INVALID:LEDGER") as CpmmLedgerLimits;
  const adapter = ints(
    l.adapter,
    ["maxTrackedSignatures", "maxResponseBytes"],
    "LIMITS_INVALID:ADAPTER",
  );
  const evidenceRecorder = ints(
    l.evidenceRecorder,
    ["maxPendingEvidence"],
    "LIMITS_INVALID:EVIDENCE_RECORDER",
  );
  const recorder = ints(
    l.recorder,
    CPMM_OBSERVATION_RECORDER_LIMIT_KEYS,
    "LIMITS_INVALID:RECORDER",
    0,
  ) as CpmmObservationRecorderLimits;
  const fanOut = ints(l.fanOut, ["maxRetainedFailures"], "LIMITS_INVALID:FAN_OUT", 0);

  // Composition relations (items 16 D and 17 G7).
  if (wrapper.maxFrameBytes !== collector.maxFrameBytes) refuse("LIMITS_INVALID:FRAME_BYTES");
  if (wrapper.handshakeTimeoutMs >= owner.ackTimeoutMs) refuse("LIMITS_INVALID:HANDSHAKE");
  if (wrapper.closeTimeoutMs > owner.cleanupTimeoutMs) refuse("LIMITS_INVALID:CLOSE");
  if (
    collector.maxRetainedFrameRecords < collector.maxEpochFrames + 1 ||
    collector.maxRetainedNotifications < collector.maxEpochFrames
  )
    refuse("LIMITS_INVALID:COLLECTOR_RETENTION");
  if (recorder.maxIncomingPayloadBytes < collector.maxEpochBytes)
    refuse("LIMITS_INVALID:RECORDER_INCOMING");
  if (recorder.maxExchangeBodyBytes < rpc.maxResponseBytes * owner.maxOutstandingResolutions)
    refuse("LIMITS_INVALID:RECORDER_EXCHANGES");
  if (adapter.maxResponseBytes > rpc.maxResponseBytes) refuse("LIMITS_INVALID:ADAPTER");
  // One never-extended lifetime holds the acquisition and the owner's whole run.
  if (session.lifetimeMs < acquisition.durationMs + ownerCeilingMs(owner))
    refuse("LIMITS_INVALID:SESSION_LIFETIME");

  return Object.freeze({
    session,
    acquisition,
    owner,
    wrapper,
    collector,
    ledger,
    adapter,
    evidenceRecorder,
    recorder,
    fanOut,
  });
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

const safeTime = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/**
 * One run. Resolves with a frozen result; never rejects for a component or provider failure.
 * Every refusal before construction returns at stage SETUP with no session, request or client.
 */
export async function runCpmmPoolObservation(
  options: CpmmObservationRunOptions,
): Promise<CpmmObservationRunResult> {
  let firstFailure: CpmmObservationRunResult["firstFailure"] = null;
  const fail = (stage: CpmmObservationRunStage, code: string): void => {
    firstFailure ??= Object.freeze({ stage, code });
  };
  const failed = (): boolean => firstFailure !== null;
  const cleanupFailures: string[] = [];
  let acquisitionSummary: CpmmObservationRunResult["acquisition"] = null;
  let acquisitionSeal: CpmmAcquisitionSealResult | null = null;
  let acquisitionVerification: CpmmPoolAcquisitionVerification | null = null;
  let started = false;
  let factoryCalls = 0;
  let report: CpmmConnectionRunReport | null = null;
  let snapshot: CpmmObservationSnapshot | null = null;
  let observationSeal: SealCpmmObservationResult | null = null;
  let observationVerification: CpmmEvidenceVerification | null = null;
  let session: PaperRequestSession | null = null;
  let acquisitionWindow: { start: number; end: number } | null = null;
  let observationWindow: { start: number; end: number } | null = null;

  const stopSession = (reason: string): void => {
    if (session === null) return;
    try {
      session.stop(reason);
    } catch {
      cleanupFailures.push("SESSION_STOP_FAILED");
    }
  };
  const result = (): CpmmObservationRunResult => {
    const s = session;
    return Object.freeze({
      kind: "CPMM_POOL_OBSERVATION_RUN_RESULT" as const,
      version: 1 as const,
      status: firstFailure === null && cleanupFailures.length === 0 ? "SUCCEEDED" : "FAILED",
      firstFailure,
      cleanupFailures: Object.freeze([...cleanupFailures]),
      acquisition: acquisitionSummary,
      acquisitionEvidence: Object.freeze({
        seal: acquisitionSeal,
        verification: acquisitionVerification,
      }),
      observation: Object.freeze({ started, transportFactoryCalls: factoryCalls, report }),
      recording: Object.freeze({ finished: snapshot !== null }),
      observationEvidence: Object.freeze({
        seal: observationSeal,
        verification: observationVerification,
      }),
      session: Object.freeze({
        stopReason: s === null ? null : s.getStopReason(),
        httpAttempts: s === null ? 0 : s.getLedgerLength(),
        acquisitionWindow: acquisitionWindow && Object.freeze({ ...acquisitionWindow }),
        observationWindow: observationWindow && Object.freeze({ ...observationWindow }),
      }),
      flags: CPMM_EVIDENCE_FALSE_FLAGS,
    }) as CpmmObservationRunResult;
  };

  // 1. Validate everything before constructing anything.
  let o: Validated;
  try {
    o = validate(options);
  } catch (e) {
    fail("SETUP", e instanceof RunRefusal ? e.code : "OPTIONS_INVALID");
    return result();
  }
  const L = o.limits;
  if (aborted(o.signal)) {
    fail("SETUP", "CANCELLED_BEFORE_START");
    return result();
  }

  // 2. Every exchange observer exists before the session can dispatch.
  let acquisition: CpmmPoolAccountAcquisition;
  let evidence: ReturnType<typeof createCpmmExchangeEvidenceRecorder>;
  let recorder: ReturnType<typeof createCpmmPoolObservationRecorder>;
  let collector: CpmmPoolNotificationCollector;
  let fanOut: ReturnType<typeof createExchangeObserverFanOut>;
  let opened: PaperRequestSession;
  try {
    acquisition = new CpmmPoolAccountAcquisition();
    evidence = createCpmmExchangeEvidenceRecorder({ ...L.evidenceRecorder });
    recorder = createCpmmPoolObservationRecorder({ limits: { ...L.recorder } });
    collector = new CpmmPoolNotificationCollector({
      binding: { ...o.target },
      limits: { ...L.collector },
      commitment: "confirmed",
    });
    const acquirer = acquisition;
    const evidenceRecorder = evidence;
    const observationRecorder = recorder;
    // The adapter's evidence recorder first, by the accepted fan-out contract.
    fanOut = createExchangeObserverFanOut({
      observers: [
        { label: "adapter-evidence", observe: (ev) => evidenceRecorder.observe(ev) },
        { label: "acquisition", observe: (ev) => acquirer.onExchangeComplete(ev) },
        { label: "observation-recorder", observe: (ev) => observationRecorder.observeExchange(ev) },
      ],
      maxRetainedFailures: L.fanOut.maxRetainedFailures,
    });
    opened = new PaperRequestSession({
      executionContext: "PAPER_SIMULATION",
      fetchFn: o.fetchFn,
      limits: L.session,
      clock: o.clock,
      timers: o.timers,
      onExchangeComplete: fanOut.observe,
    });
    evidence.bind(opened);
  } catch {
    fail("SETUP", "COMPOSITION_FAILED");
    return result();
  }
  session = opened;
  try {
    opened.open();
  } catch {
    fail("SETUP", "SESSION_OPEN_FAILED");
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }

  // 3. Acquire once, on the shared session.
  const acquisitionStart = opened.now();
  if (!safeTime(acquisitionStart)) {
    fail("SETUP", "CLOCK_INVALID");
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }
  const deadlineMs = acquisitionStart + L.acquisition.durationMs;
  const ledgerStart = opened.getLedgerLength();
  let acquired: CpmmPoolAccountAcquisitionResult;
  try {
    acquired = await acquisition.acquire({
      session: opened,
      url: o.rpcUrl,
      target: { ...o.target },
      deadlineMs,
      timers: { setTimeout: o.timers.setTimeout, clearTimeout: o.timers.clearTimeout },
      timeoutMs: L.acquisition.timeoutMs,
      maxResponseBytes: L.acquisition.maxResponseBytes,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
  } catch {
    fail("ACQUISITION", "ACQUISITION_THREW");
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }
  const ledgerEnd = opened.getLedgerLength();
  acquisitionWindow = { start: ledgerStart, end: ledgerEnd };
  acquisitionSummary = Object.freeze({
    outcome: acquired.outcome,
    code: acquired.code,
    stage: acquired.stage,
    sessionStopReason:
      acquired.outcome === "ACQUIRED" ? null : (acquired.sessionStopReason ?? null),
    retainedExchanges: acquired.exchanges.length,
  });
  if (acquired.outcome !== "ACQUIRED") fail("ACQUISITION", acquired.code);

  // 4. Seal and verify the acquisition, whatever its outcome.
  acquisitionSeal = sealCpmmPoolAcquisitionEvidence({
    projectRoot: o.projectRoot,
    runId: o.runId,
    target: { ...o.target },
    limits: {
      deadlineMs,
      timeoutMs: L.acquisition.timeoutMs,
      maxResponseBytes: L.acquisition.maxResponseBytes,
      pacingMs: L.session.lanes.SOLANA_RPC.pacingMs,
    },
    ledger: opened.getLedgerSince(ledgerStart).slice(0, ledgerEnd - ledgerStart),
    result: acquired,
    credentials: { urls: [...o.credentials.urls], additional: [...o.credentials.additional] },
  });
  if (!acquisitionSeal.ok) {
    fail("ACQUISITION_EVIDENCE", `SEAL_FAILED:${acquisitionSeal.code}`);
  } else {
    acquisitionVerification = verifyCpmmPoolAcquisitionEvidence(acquisitionSeal.outDir);
    if (acquisitionVerification.integrity !== "VERIFIED") {
      fail(
        "ACQUISITION_EVIDENCE",
        `INTEGRITY_FAILED:${acquisitionVerification.integrityCode ?? "UNKNOWN"}`,
      );
    } else if (acquisitionVerification.manifestSha256 !== acquisitionSeal.manifestSha256) {
      fail("ACQUISITION_EVIDENCE", "MANIFEST_DIGEST_MISMATCH");
    } else if (acquisitionVerification.computed !== "ACQUIRED_REPRODUCED") {
      fail("ACQUISITION_EVIDENCE", `NOT_REPRODUCED:${acquisitionVerification.computed}`);
    }
  }
  if (failed() || acquired.outcome !== "ACQUIRED" || !acquisitionSeal.ok) {
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }
  const acquisitionDir = acquisitionSeal.outDir;
  const acquisitionManifest = acquisitionSeal.manifestSha256;

  // 5. Stage boundary: one wait through the injected timers, then every stop condition.
  try {
    await new Promise<void>((resolve) => {
      o.timers.setTimeout(resolve, 0);
    });
  } catch {
    fail("STAGE_BOUNDARY", "TIMER_FAILED");
  }
  const observationStart = opened.now();
  if (!failed()) {
    if (aborted(o.signal)) fail("STAGE_BOUNDARY", "CANCELLED");
    else if (!opened.isOpen() || opened.getStopReason() !== null)
      fail("STAGE_BOUNDARY", "SESSION_STOPPED");
    else if (!safeTime(observationStart) || observationStart < acquisitionStart)
      fail("STAGE_BOUNDARY", "CLOCK_INVALID");
    else if ((opened.getDeadlineMs() ?? 0) - observationStart < ownerCeilingMs(L.owner))
      fail("STAGE_BOUNDARY", "SESSION_LIFETIME_INSUFFICIENT");
  }
  if (failed()) {
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }

  // 6. Observe: one owner, one connection.
  let owner: CpmmPoolConnectionOwner;
  let ledger: CpmmResolutionAccountingLedger;
  let wrapper: CpmmPoolWebSocketTransport | null = null;
  try {
    const pool = acquired.adapted;
    const adapter = new RaydiumCpmmTransactionSourceAdapter({
      pool,
      session: opened,
      evidence,
      rpcUrl: o.rpcUrl,
      secrets: [...o.analysisSecrets],
      ...L.adapter,
    });
    ledger = new CpmmResolutionAccountingLedger({
      binding: adapter.getBinding(),
      adapter,
      tracker: new RollingTradeFlowTracker({
        poolId: pool.poolAddress,
        tokenMint: pool.candidateMint,
        trackingStartedMs: observationStart,
        clock: o.clock,
      }),
      limits: { ...L.ledger },
    });
    const observationRecorder = recorder;
    owner = new CpmmPoolConnectionOwner({
      session: opened,
      collector,
      ledger: recorder.recordLedger(ledger),
      binding: adapter.getBinding(),
      transportFactory: (): CpmmOwnerTransport => {
        factoryCalls++;
        if (wrapper !== null) throw new Error("[CPMM_RUN] SECOND_TRANSPORT_REFUSED");
        wrapper = new CpmmPoolWebSocketTransport({
          endpoint: o.streamUrl,
          clientConstructor: o.ctor,
          limits: { ...L.wrapper },
        });
        return observationRecorder.recordTransport(wrapper);
      },
      timers: o.timers,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      epoch: o.epoch,
      subscribeRequestId: o.subscribeRequestId,
      unsubscribeRequestId: o.unsubscribeRequestId,
      limits: { ...L.owner },
    });
  } catch {
    fail("OBSERVATION", "COMPOSITION_FAILED");
    stopSession(CPMM_RUN_STOP_ABANDONED);
    return result();
  }
  const sessionLedgerStart = opened.getLedgerLength();
  started = true;
  report = await owner.run();
  if (report.terminal.cause !== "OBSERVATION_COMPLETED") {
    fail(
      "OBSERVATION",
      report.terminal.code === null
        ? report.terminal.cause
        : `${report.terminal.cause}:${report.terminal.code}`,
    );
  }
  const ownerCleanup = report.cleanup.status;
  if (ownerCleanup === "FAILED_STILL_OPEN" || ownerCleanup === "DISPOSE_FAILED")
    cleanupFailures.push(`OWNER_CLEANUP:${ownerCleanup}`);
  else if (!report.connectionRunClean) fail("OBSERVATION", "CONNECTION_RUN_NOT_CLEAN");

  // 7. Settled: finish the recorder here (a continuation, outside every callback), then stop.
  try {
    snapshot = recorder.finish({
      report,
      owner,
      wrapper,
      collector,
      ledger,
      session: opened,
      sessionLedgerStart,
      epoch: o.epoch,
      fanOut,
    });
  } catch {
    fail("RECORDING", "FINISH_FAILED");
  }
  observationWindow = { start: sessionLedgerStart, end: opened.getLedgerLength() };
  stopSession(CPMM_RUN_STOP_FINISHED);
  if (snapshot === null) return result();

  // 8. Seal the observation with its exact dependency, then verify both offline.
  const plan = {
    kinds: {
      run: "CPMM_POOL_OBSERVATION_RUN",
      acquisition: "CPMM_POOL_ACCOUNT_ACQUISITION",
      owner: "CPMM_POOL_CONNECTION_OWNER",
      wrapper: "CPMM_POOL_WEBSOCKET_TRANSPORT",
      recorder: "CPMM_POOL_OBSERVATION_RECORDER",
    },
    limits: {
      owner: { ...L.owner },
      wrapper: { ...L.wrapper },
      collector: { ...L.collector },
      ledger: { ...L.ledger },
      adapter: { ...L.adapter },
      sessionLanes: Object.fromEntries(
        PAPER_REQUEST_LANES.map((lane) => [lane, { ...L.session.lanes[lane] }]),
      ),
      recorder: { ...L.recorder },
    },
    binding: { ...o.target },
    epoch: o.epoch,
    subscribeRequestId: o.subscribeRequestId,
    unsubscribeRequestId: o.unsubscribeRequestId,
    endpointLabels: { rpc: "SOLANA_RPC_HTTP", stream: "SOLANA_RPC_WEBSOCKET" },
  };
  const account = (a: {
    address: string;
    ownerProgramId: string;
    slot: number;
    data: Uint8Array;
  }) => ({
    address: a.address,
    ownerProgramId: a.ownerProgramId,
    slot: a.slot,
    data: a.data,
  });
  observationSeal = sealCpmmObservationEvidence({
    projectRoot: o.projectRoot,
    runId: o.runId,
    snapshot,
    plan,
    componentVersions: { ...o.componentVersions },
    poolContext: {
      target: { ...o.target },
      poolAccount: account(acquired.input.poolAccount),
      vault0Account: account(acquired.input.vault0Account),
      vault1Account: account(acquired.input.vault1Account),
      adaptedPool: acquired.adapted,
      acquisition: "SUPPLIED_UNVERIFIED",
    },
    acquisitionDir,
    credentials: { urls: [...o.credentials.urls], additional: [...o.credentials.additional] },
    lateActivity: { ...recorder.lateActivity() },
  });
  if (!observationSeal.ok) {
    fail("OBSERVATION_EVIDENCE", `SEAL_FAILED:${observationSeal.code}`);
    return result();
  }
  observationVerification = verifyCpmmObservationEvidence(observationSeal.outDir, {
    analysisSecrets: [...o.analysisSecrets],
    acquisitionDir,
  });
  const binding = observationVerification.acquisitionBinding;
  if (!observationVerification.integrity.ok) fail("OBSERVATION_EVIDENCE", "INTEGRITY_FAILED");
  else if (observationVerification.manifestSha256 !== observationSeal.manifestSha256)
    fail("OBSERVATION_EVIDENCE", "MANIFEST_DIGEST_MISMATCH");
  else if (binding === undefined) fail("OBSERVATION_EVIDENCE", "ACQUISITION_BINDING_MISSING");
  else if (binding.status !== "REPRODUCED")
    fail("OBSERVATION_EVIDENCE", `ACQUISITION_BINDING:${binding.status}`);
  else if (
    binding.expectedManifestSha256 !== acquisitionManifest ||
    binding.manifestSha256 !== acquisitionManifest
  )
    fail("OBSERVATION_EVIDENCE", "ACQUISITION_DEPENDENCY_MISMATCH");
  return result();
}
