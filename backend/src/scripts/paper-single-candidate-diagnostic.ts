#!/usr/bin/env node
/**
 * NeXusTrade — PAPER single-candidate operator diagnostic (decision-only).
 *
 * A standalone runner around PaperSingleCandidateCoordinator for ONE explicit pool and mint. It never
 * starts the PAPER daemon or its loops, never buys and never creates a position: it stops at the
 * coordinator's confirmation or any other terminal outcome and seals reviewable evidence.
 *
 * Execution boundary:
 * - Default is a dry run: it validates the arguments and prints the complete proposed plan. It loads
 *   no configuration, opens no socket, sends no request and creates no file or directory.
 * - Real dispatch requires the explicit --live flag, which is AWAITING SEPARATE OPERATOR APPROVAL.
 *   Only then are configuration (existing loader), the HTTP transport and the WebSocket transport
 *   wired. Secrets are never printed or persisted.
 * - No target substitution, discovery, retry or rerun. The output directory must be new and inside
 *   the project's data/research/single-candidate/ evidence root; existing evidence is never
 *   overwritten.
 * - Evidence: every dispatched request's safe identity and its bounded response (from the session's
 *   own bounded read; partial bodies are marked and never complete), WebSocket observations with
 *   receipt times and epochs, recorded gaps, and the security and flow inputs each decision
 *   consumed. Everything is redacted before it is written, and all terminal output and propagated
 *   errors after configuration is loaded are redacted too.
 * - --verify checks INTEGRITY only (manifest structure, required entries, sizes and digests, plan
 *   references); matching hashes do not replay or re-validate the strategy.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { isCanonicalSolanaBase58 } from "../candidate-scanner/LpScreeningBridge.js";
import {
  PaperSingleCandidateCoordinator,
  type PaperCoordinatorLimits,
  type PaperCoordinatorReport,
} from "../candidate-scanner/PaperSingleCandidateCoordinator.js";
import {
  parseDexScreenerTokenPairs,
  type DexScreenerMarketParseResult,
} from "../candidate-scanner/DexScreenerSingleCandidateMarketParser.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import {
  WsWebSocketTransport,
  type ISolanaKeepaliveWebSocketTransport,
} from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import type {
  PaperRequestExchangeEvidence,
  PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import {
  buildEscapedSecretRegex,
  redactSensitiveText,
} from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { serializeJsonPreservingBigInts } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { loadDaemonEnvironment } from "./paper-trading-daemon.js";

export const EVIDENCE_ROOT_SEGMENTS = ["data", "research", "single-candidate"] as const;
export const LIVE_APPROVAL_STATUS = "LIVE_EXECUTION_AWAITING_SEPARATE_OPERATOR_APPROVAL" as const;

/** Public endpoints for the explicit live path (the RPC URL and key come from configuration). */
export const SINGLE_CANDIDATE_PUBLIC_ENDPOINTS = Object.freeze({
  rugCheckApiUrl: "https://api.rugcheck.xyz",
  solanaTrackerApiUrl: "https://data.solanatracker.io",
  marketUrlFor: (mint: string) =>
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
});

/**
 * PROPOSED configuration for one live run. Not approved: every value awaits separate operator
 * approval. Per-request limits keep the shared ledger, pacing, deadlines, response ceilings, the
 * first-429 stop and cancellation behaviour of the accepted components.
 */
export const PROPOSED_SINGLE_CANDIDATE_LIMITS: PaperCoordinatorLimits = Object.freeze({
  session: Object.freeze({
    lifetimeMs: 600_000,
    maxHttpAttempts: 340,
    requestTimeoutMs: 10_000,
    lanes: Object.freeze({
      SOLANA_RPC: Object.freeze({ maxAttempts: 320, pacingMs: 2_500, maxResponseBytes: 262_144 }),
      RUGCHECK: Object.freeze({ maxAttempts: 6, pacingMs: 5_000, maxResponseBytes: 4_194_304 }),
      SOLANA_TRACKER: Object.freeze({
        maxAttempts: 6,
        pacingMs: 5_000,
        maxResponseBytes: 1_048_576,
      }),
      DEXSCREENER: Object.freeze({ maxAttempts: 9, pacingMs: 1_000, maxResponseBytes: 262_144 }),
    }),
  }),
  flow: Object.freeze({
    lifetimeMs: 600_000,
    maxHttpAttempts: 300,
    maxNotifications: 60,
    maxTransactionRetrievals: 60,
    maxReconnects: 1,
    maxRetrievalsPerCycle: 4,
    queueCeiling: 13,
    rpcPacingMs: 2_500,
    requestTimeoutMs: 5_000,
    maxResponseBytes: 262_144,
    subscriptionAckTimeoutMs: 5_000,
    keepalivePingIntervalMs: 20_000,
    keepalivePongTimeoutMs: 10_000,
    maxKeepalivePings: 32,
    maxWsMessages: 80,
    maxWsMessageBytes: 1_048_576,
    maxWsControlFrames: 80,
  }),
  loader: Object.freeze({ lpAcquisitionTimeoutMs: 30_000, maxLoads: 6 }),
  cache: Object.freeze({ maxRefreshes: 6 }),
  schedule: Object.freeze({
    prefetchLeadMs: 6_000,
    confirmDelayMs: 5_000,
    decisionIntervalMs: 5_000,
    decisionLeadMs: 1_500,
    refreshHorizonMs: 10_000,
    tickMs: 250,
    maxDecisions: 8,
    maxPrefetchEpochs: 2,
  }),
}) as PaperCoordinatorLimits;

/** Security requests per load: LP pool account + LP account batch + mint account (Solana), 1 + 1. */
const SECURITY_SOLANA_PER_LOAD = 3;

export interface RequestAllocation {
  readonly solanaRpc: {
    readonly flow: number;
    readonly security: number;
    readonly total: number;
    readonly laneCeiling: number;
    readonly reconnectAllowance: number;
  };
  readonly rugCheck: { readonly total: number; readonly laneCeiling: number };
  readonly solanaTracker: { readonly total: number; readonly laneCeiling: number };
  readonly market: {
    readonly intake: number;
    readonly decisions: number;
    readonly total: number;
    readonly laneCeiling: number;
  };
  readonly refreshes: { readonly maxRefreshes: number; readonly maxLoads: number };
  readonly total: number;
  readonly sessionCeiling: number;
}

/** Complete worst-case request allocation; throws if any lane or the session cannot hold it. */
export function buildRequestAllocation(limits: PaperCoordinatorLimits): RequestAllocation {
  const loads = Math.min(limits.loader.maxLoads, limits.cache.maxRefreshes);
  const lanes = limits.session.lanes;
  const allocation: RequestAllocation = {
    solanaRpc: {
      flow: limits.flow.maxHttpAttempts,
      security: SECURITY_SOLANA_PER_LOAD * loads,
      total: limits.flow.maxHttpAttempts + SECURITY_SOLANA_PER_LOAD * loads,
      laneCeiling: lanes.SOLANA_RPC.maxAttempts,
      reconnectAllowance: limits.flow.maxReconnects,
    },
    rugCheck: { total: loads, laneCeiling: lanes.RUGCHECK.maxAttempts },
    solanaTracker: { total: loads, laneCeiling: lanes.SOLANA_TRACKER.maxAttempts },
    market: {
      intake: 1,
      decisions: limits.schedule.maxDecisions,
      total: 1 + limits.schedule.maxDecisions,
      laneCeiling: lanes.DEXSCREENER.maxAttempts,
    },
    refreshes: { maxRefreshes: limits.cache.maxRefreshes, maxLoads: limits.loader.maxLoads },
    total: 0,
    sessionCeiling: limits.session.maxHttpAttempts,
  };
  const total =
    allocation.solanaRpc.total +
    allocation.rugCheck.total +
    allocation.solanaTracker.total +
    allocation.market.total;
  const checks: [boolean, string][] = [
    [allocation.solanaRpc.total <= allocation.solanaRpc.laneCeiling, "Solana RPC lane"],
    [allocation.rugCheck.total <= allocation.rugCheck.laneCeiling, "RugCheck lane"],
    [allocation.solanaTracker.total <= allocation.solanaTracker.laneCeiling, "Solana Tracker lane"],
    [allocation.market.total <= allocation.market.laneCeiling, "market lane"],
    [total <= allocation.sessionCeiling, "session ceiling"],
  ];
  for (const [ok, what] of checks) {
    if (!ok) throw new Error(`[PLAN_INVALID] the worst-case allocation exceeds the ${what}`);
  }
  return { ...allocation, total };
}

export interface PaperSingleCandidatePlan {
  readonly kind: "PAPER_SINGLE_CANDIDATE_DIAGNOSTIC_PLAN";
  readonly executionContext: "PAPER_SIMULATION";
  readonly mode: "DRY_RUN" | "LIVE";
  readonly approval: typeof LIVE_APPROVAL_STATUS;
  readonly target: { readonly poolId: string; readonly mintAddress: string };
  /** Output directory relative to the project root (new; never overwritten). */
  readonly outDir: string;
  readonly endpoints: {
    readonly solanaRpc: "SOLANA_RPC_URL (configuration; never printed)";
    readonly solanaWebSocket: "derived from SOLANA_RPC_URL (http->ws, https->wss)";
    readonly rugCheck: string;
    readonly solanaTracker: string;
    readonly solanaTrackerKeySource: "SOLANA_TRACKER_API_KEY (configuration; never printed)";
    readonly market: string;
  };
  readonly limits: PaperCoordinatorLimits;
  readonly allocation: RequestAllocation;
  readonly scannerConfig: typeof CANDIDATE_SCANNER_DEFAULTS;
  readonly stopConditions: readonly string[];
  readonly boundaries: readonly string[];
  readonly evidenceFiles: readonly string[];
}

/** Required core files of every sealed run (the manifest is written last). */
export const CORE_EVIDENCE_FILES = [
  "plan.json",
  "report.json",
  "summary.json",
  "request-ledger.json",
  "request-exchanges.json",
  "decisions.json",
  "decision-inputs.json",
  "disarms.json",
  "market-responses.json",
  "security-evidence.json",
  "flow-evidence.json",
  "ws-observations.json",
  "evidence-manifest.json",
] as const;
/** One bounded response-evidence file per dispatched request, by session ledger sequence. */
export const EXCHANGE_EVIDENCE_DIR = "exchanges";
export const exchangeEvidencePath = (seq: number) =>
  `${EXCHANGE_EVIDENCE_DIR}/${String(seq).padStart(4, "0")}.json`;
const EVIDENCE_FILES = [
  ...CORE_EVIDENCE_FILES,
  `${EXCHANGE_EVIDENCE_DIR}/NNNN.json (one per dispatched request)`,
] as const;
export const MANIFEST_KIND = "PAPER_SINGLE_CANDIDATE_EVIDENCE_MANIFEST" as const;
export const MANIFEST_VERSION = 2 as const;
/** The verifier's scope, stated with every result. */
export const VERIFY_SCOPE =
  "INTEGRITY_ONLY: manifest structure, required entries, sizes, SHA-256 digests and plan-digest references of the sanitized files. It does not replay or re-validate decisions or strategy." as const;
const RPC_URL_PLACEHOLDER = "SOLANA_RPC_URL (configuration; not recorded)";

/** Pure plan construction and validation (no I/O beyond path resolution). */
export function buildPaperSingleCandidatePlan(input: {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly outDirRelative: string;
  readonly mode: "DRY_RUN" | "LIVE";
  readonly limits: PaperCoordinatorLimits;
}): PaperSingleCandidatePlan {
  return {
    kind: "PAPER_SINGLE_CANDIDATE_DIAGNOSTIC_PLAN",
    executionContext: "PAPER_SIMULATION",
    mode: input.mode,
    approval: LIVE_APPROVAL_STATUS,
    target: { poolId: input.poolId, mintAddress: input.mintAddress },
    outDir: input.outDirRelative,
    endpoints: {
      solanaRpc: "SOLANA_RPC_URL (configuration; never printed)",
      solanaWebSocket: "derived from SOLANA_RPC_URL (http->ws, https->wss)",
      rugCheck: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.rugCheckApiUrl,
      solanaTracker: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.solanaTrackerApiUrl,
      solanaTrackerKeySource: "SOLANA_TRACKER_API_KEY (configuration; never printed)",
      market: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(input.mintAddress),
    },
    limits: input.limits,
    allocation: buildRequestAllocation(input.limits),
    scannerConfig: CANDIDATE_SCANNER_DEFAULTS,
    stopConditions: [
      "ENTRY_CONFIRMED_NO_EXECUTION (retest confirmed; no buy, no position)",
      "CANDIDATE_DROPPED (retest rejected or insufficient live liquidity)",
      "INTAKE_REJECTED (validated-LP scanner, market identity or market snapshot unavailable)",
      "SECURITY_REFRESH_BUDGET_EXHAUSTED / DECISION_BUDGET_EXHAUSTED_WHILE_ARMED",
      "FLOW_COLLECTION_ENDED (flow lifetime, ceilings, reconnect ceiling, first 429, redirect)",
      "REQUEST_SESSION_STOPPED (session deadline, first 429, redirect, shared ceiling)",
      "OPERATOR_INTERRUPT (SIGINT)",
    ],
    boundaries: [
      "PAPER_SIMULATION only; one fixed pool and mint; no target substitution or discovery",
      "No PAPER daemon, no daemon loops, no Birdeye, no Smart Money, no unrelated traffic",
      "No buy, no position, no order, no wallet change",
      "No retries and no reruns; one run per new output directory",
      "Every request in one session ledger; first 429 and any redirect stop the session",
      "Flow qualification is reported separately from strategy acceptance",
    ],
    evidenceFiles: EVIDENCE_FILES,
  };
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export interface PaperSingleCandidateDiagnosticDeps {
  /** Configuration source for the live path (default: process.env after the existing loader). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Existing configuration loader (default: loadDaemonEnvironment); called only for --live. */
  readonly loadEnvironment?: (() => void) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly createWebSocketTransport?:
    | ((wsUrl: string) => ISolanaKeepaliveWebSocketTransport)
    | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly projectRoot?: string | undefined;
  /** Aborting stops the run (operator interrupt); evidence is still sealed. */
  readonly signal?: AbortSignal | undefined;
  /** Offline tests only: replace the proposed limits. */
  readonly limits?: PaperCoordinatorLimits | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface PaperSingleCandidateDiagnosticResult {
  readonly mode: "DRY_RUN" | "LIVE";
  readonly plan: PaperSingleCandidatePlan;
  readonly planDigestSha256: string;
  readonly outDir?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly manifestDigestSha256?: string | undefined;
}

function cliError(message: string): Error {
  return new Error(`[CLI_INVALID_ARG] ${message}`);
}

/**
 * Secrets to redact from anything persisted or printed: the key, the RPC and derived WebSocket URLs
 * and their credential parts. Longest first, so a whole URL is replaced before its parts.
 */
function secretsFrom(rpcUrl: string, apiKey: string, wsUrl: string): string[] {
  const secrets = new Set<string>([apiKey, rpcUrl, wsUrl]);
  for (const url of [rpcUrl, wsUrl]) {
    try {
      const u = new URL(url);
      if (u.username) secrets.add(u.username);
      if (u.password) secrets.add(u.password);
      for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
      for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
    } catch {
      // An unparsable URL is rejected before use; nothing more to collect.
    }
  }
  return [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

interface ManifestFileEntry {
  readonly path: string;
  readonly category: "REPORT" | "EVIDENCE" | "RESPONSE";
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Evidence redaction: every configured credential, in literal and escaped forms, is replaced.
 * Generic credential-pattern rewriting is NOT applied to evidence content, because it would also
 * alter provider data (for example any JSON key named "token") and so destroy the evidence; it is
 * used for terminal output and errors instead. The seal still refuses any residual credential.
 */
function literalRedactor(secrets: readonly string[]): (text: string) => string {
  const patterns = secrets.map((s) => {
    try {
      return buildEscapedSecretRegex(s);
    } catch {
      return null;
    }
  });
  return (text: string) => {
    let out = text;
    secrets.forEach((secret, i) => {
      out = out.split(secret).join("[REDACTED]");
      const escaped = patterns[i];
      if (escaped) out = out.replace(escaped, "[REDACTED]");
    });
    return out;
  };
}

/** Applies a string redactor to every string (and key) in a JSON-compatible tree. */
function deepRedactStrings(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => deepRedactStrings(v, redact));
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        redact(k),
        deepRedactStrings(v, redact),
      ]),
    );
  }
  return value;
}

/** Exclusive (never overwriting) writes of sanitized files; a residual secret refuses the write. */
function sealedWriter(outDir: string, secrets: readonly string[]) {
  const redact = literalRedactor(secrets);
  const entries: ManifestFileEntry[] = [];
  const writeText = (rel: string, content: string, category: ManifestFileEntry["category"]) => {
    for (const secret of secrets) {
      if (content.includes(secret)) {
        throw new Error(`[SEAL_REFUSED] a secret would be persisted in ${rel}`);
      }
    }
    writeFileSync(path.join(outDir, ...rel.split("/")), content, { encoding: "utf8", flag: "wx" });
    const meta: ManifestFileEntry = {
      path: rel,
      category,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    };
    entries.push(meta);
    return meta;
  };
  const writeJson = (rel: string, data: unknown, category: ManifestFileEntry["category"]) =>
    writeText(rel, serializeJsonPreservingBigInts(deepRedactStrings(data, redact)), category);
  return { entries, writeText, writeJson, redact };
}

/**
 * One dispatched request's safe identity and bounded response evidence. Request headers are never
 * recorded; the RPC URL is replaced by a placeholder; other URLs and the body are redacted. The
 * received-bytes digest is of the ORIGINAL bytes (before redaction); the manifest's digests are of
 * the sanitized files.
 */
function exchangeRecord(e: PaperRequestExchangeEvidence, redact: (text: string) => string) {
  const entry = e.entry;
  let bodyKind: "NONE" | "JSON_RPC" | "OTHER" = e.requestBody === null ? "NONE" : "OTHER";
  let rpcMethod: string | null = null;
  let rpcParams: unknown = null;
  if (e.requestBody !== null) {
    try {
      const parsed = JSON.parse(e.requestBody) as {
        jsonrpc?: unknown;
        method?: unknown;
        params?: unknown;
      };
      if (parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0") {
        bodyKind = "JSON_RPC";
        rpcMethod = typeof parsed.method === "string" ? parsed.method : null;
        rpcParams = parsed.params ?? null;
      }
    } catch {
      // Not JSON: only its kind is recorded.
    }
  }
  const received = e.body;
  let body: string | null = null;
  let bodyEncoding: "utf8" | "base64" | null = null;
  let bodyRedacted = false;
  if (received !== null) {
    const text = received.toString("utf8");
    if (Buffer.from(text, "utf8").equals(received)) {
      body = redact(text);
      bodyEncoding = "utf8";
      bodyRedacted = body !== text;
    } else {
      body = received.toString("base64");
      bodyEncoding = "base64";
    }
  }
  return {
    kind: "PAPER_REQUEST_EXCHANGE_EVIDENCE",
    seq: entry.seq,
    lane: entry.lane,
    owner: entry.owner,
    purpose: entry.purpose,
    requestedIdentity: entry.requestedIdentity,
    jsonRpcId: entry.jsonRpcId,
    request: {
      method: e.method,
      url: entry.lane === "SOLANA_RPC" ? RPC_URL_PLACEHOLDER : redact(e.url),
      headersRecorded: false,
      bodyKind,
      rpcMethod,
      rpcParams,
    },
    dispatchedAtMs: entry.dispatchedAtMs,
    completedAtMs: entry.completedAtMs,
    httpStatus: entry.httpStatus,
    error: entry.error,
    response: {
      headers: e.responseHeaders,
      bodyState: e.bodyState,
      /** Only a complete body is complete evidence; a partial prefix never is. */
      completeEvidence: e.bodyState === "COMPLETE",
      retainedBytes: received?.length ?? null,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      receivedBytesSha256: received === null ? null : sha256(received),
      receivedDigestScope:
        received === null
          ? null
          : e.bodyState === "COMPLETE"
            ? "ORIGINAL_COMPLETE_BODY_BYTES"
            : "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
      bodyEncoding,
      bodyRedacted,
      reproducesReceivedDigest: received !== null && !bodyRedacted,
      body,
    },
  };
}

type WsObservationKind =
  | "OPEN"
  | "MESSAGE"
  | "SEND"
  | "CLOSE"
  | "ERROR"
  | "PING_SENT"
  | "PONG"
  | "PING_RECEIVED";

interface WsObservationLog {
  transportsCreated: number;
  retainedBytes: number;
  dropped: number;
  readonly observations: Record<string, unknown>[];
}

/**
 * Bounded WebSocket observation: records each event once (its own listeners are registered first,
 * at creation) with its receipt time and the flow epoch state at receipt. Message and send payloads
 * are retained up to the flow's own message-byte ceiling; beyond it only metadata is kept, and
 * beyond the entry ceiling only a dropped count. Every member of the transport is passed through.
 */
function observeWebSocket(
  inner: ISolanaKeepaliveWebSocketTransport,
  index: number,
  log: WsObservationLog,
  caps: { readonly maxEntries: number; readonly maxRetainedBytes: number },
  clock: () => number,
  epochState: () => unknown,
  redact: (text: string) => string,
): ISolanaKeepaliveWebSocketTransport {
  const record = (kind: WsObservationKind, data?: string | Buffer, extra: object = {}) => {
    if (log.observations.length >= caps.maxEntries) {
      log.dropped++;
      return;
    }
    const bytes =
      data === undefined ? null : typeof data === "string" ? Buffer.byteLength(data) : data.length;
    let retained: string | null = null;
    if (
      bytes !== null &&
      (kind === "MESSAGE" || kind === "SEND") &&
      log.retainedBytes + bytes <= caps.maxRetainedBytes
    ) {
      retained = redact(typeof data === "string" ? data : data!.toString("utf8"));
      log.retainedBytes += bytes;
    }
    log.observations.push({
      seq: log.observations.length + 1,
      transportIndex: index,
      kind,
      atMs: clock(),
      epochAtReceipt: epochState(),
      bytes,
      dataRetained: retained !== null,
      data: retained,
      ...extra,
    });
  };
  inner.on("open", () => record("OPEN"));
  inner.on("message", (data: string | Buffer) => record("MESSAGE", data));
  inner.on("close", (code: number, reason: string) =>
    record("CLOSE", undefined, { code, reason: redact(String(reason ?? "")) }),
  );
  inner.on("error", (err: Error) =>
    record("ERROR", undefined, { error: redact(err instanceof Error ? err.message : String(err)) }),
  );
  inner.on("pong", (data: Buffer) => record("PONG", undefined, { bytes: data?.length ?? 0 }));
  inner.on("ping", (data: Buffer) =>
    record("PING_RECEIVED", undefined, { bytes: data?.length ?? 0 }),
  );
  const wrapped: Record<string, unknown> = {
    send: (data: string) => {
      record("SEND", data);
      return inner.send(data);
    },
    close: (code?: number, reason?: string) => inner.close(code, reason),
    on: (event: string, listener: (...args: never[]) => void) =>
      (inner.on as (e: string, l: (...args: never[]) => void) => void)(event, listener),
  };
  if (typeof inner.ping === "function") {
    wrapped.ping = (data?: Buffer, cb?: (err?: Error) => void) => {
      record("PING_SENT", undefined, { bytes: data?.length ?? 0 });
      return inner.ping!(data, cb);
    };
  }
  if (typeof inner.terminate === "function") wrapped.terminate = () => inner.terminate!();
  if (typeof inner.destroy === "function") wrapped.destroy = () => inner.destroy!();
  if (typeof inner.getUnderlyingSocket === "function") {
    wrapped.getUnderlyingSocket = () => inner.getUnderlyingSocket!();
  }
  Object.defineProperty(wrapped, "readyState", { get: () => inner.readyState, enumerable: true });
  return wrapped as unknown as ISolanaKeepaliveWebSocketTransport;
}

/** Runs the diagnostic. Returns after the plan (dry run) or after sealing (live). */
export async function runPaperSingleCandidateDiagnostic(
  rawArgs: readonly string[],
  deps: PaperSingleCandidateDiagnosticDeps = {},
): Promise<PaperSingleCandidateDiagnosticResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        pool: { type: "string" },
        mint: { type: "string" },
        "out-dir": { type: "string" },
        live: { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
      strict: true,
      tokens: true,
    }));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err));
  }
  // parseArgs keeps the last value of a repeated option; a repeated target must not substitute.
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === undefined) continue;
    if (seen.has(token.name)) throw cliError(`--${token.name} may be given only once`);
    seen.add(token.name);
  }
  const poolId = typeof values.pool === "string" ? values.pool : "";
  const mintAddress = typeof values.mint === "string" ? values.mint : "";
  if (!isCanonicalSolanaBase58(poolId)) throw cliError("--pool must be a canonical Solana address");
  if (!isCanonicalSolanaBase58(mintAddress)) {
    throw cliError("--mint must be a canonical Solana address");
  }
  if (poolId === mintAddress) throw cliError("--pool and --mint must differ");
  if (values.live === true && values["dry-run"] === true) {
    throw cliError("--live and --dry-run are mutually exclusive");
  }
  const rawOut = typeof values["out-dir"] === "string" ? values["out-dir"] : "";
  if (rawOut === "") throw cliError("--out-dir is required (a new directory)");
  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const evidenceRoot = path.join(projectRoot, ...EVIDENCE_ROOT_SEGMENTS);
  const outDir = path.resolve(projectRoot, rawOut);
  const relativeToRoot = path.relative(evidenceRoot, outDir);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw cliError(`--out-dir must be a new directory inside ${EVIDENCE_ROOT_SEGMENTS.join("/")}/`);
  }
  if (existsSync(outDir)) {
    throw new Error(
      `[OUTPUT_EXISTS] ${path.relative(projectRoot, outDir)} already exists; refusing to overwrite`,
    );
  }
  const mode = values.live === true ? "LIVE" : "DRY_RUN";
  const limits = deps.limits ?? PROPOSED_SINGLE_CANDIDATE_LIMITS;
  const plan = buildPaperSingleCandidatePlan({
    poolId,
    mintAddress,
    outDirRelative: path.relative(projectRoot, outDir).replace(/\\/g, "/"),
    mode,
    limits,
  });
  // The plan exactly as sealed (plan.json); the digest is of these bytes.
  const planJson = serializeJsonPreservingBigInts(plan);
  const planDigestSha256 = sha256(planJson);

  if (mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no socket opened, no request sent, nothing written.");
    log(`[DRY_RUN] Live execution: ${LIVE_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode, plan, planDigestSha256 };
  }

  // ------------------------------------------------------------------------------------------
  // Explicit live path (awaiting separate operator approval). Configuration is loaded only here.
  // ------------------------------------------------------------------------------------------
  (deps.loadEnvironment ?? loadDaemonEnvironment)();
  const env = deps.env ?? process.env;
  const rpcUrl = env.SOLANA_RPC_URL ?? "";
  const apiKey = env.SOLANA_TRACKER_API_KEY ?? "";
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new Error(
      "[MISSING_CONFIGURATION] SOLANA_RPC_URL (http or https) is required for --live",
    );
  }
  if (apiKey === "") {
    throw new Error("[MISSING_CONFIGURATION] SOLANA_TRACKER_API_KEY is required for --live");
  }
  const wsUrl = rpcUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const secrets = secretsFrom(rpcUrl, apiKey, wsUrl);
  const redact = (text: string) => redactSensitiveText(text, secrets);
  // Every line printed after configuration is loaded, and every error propagated, is redacted.
  const out = (line: string) => log(redact(line));
  try {
    return await runLive({
      deps,
      out,
      redact,
      secrets,
      rpcUrl,
      apiKey,
      wsUrl,
      poolId,
      mintAddress,
      projectRoot,
      outDir,
      limits,
      plan,
      planJson,
      planDigestSha256,
    });
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err)));
  }
}

async function runLive(ctx: {
  readonly deps: PaperSingleCandidateDiagnosticDeps;
  readonly out: (line: string) => void;
  readonly redact: (text: string) => string;
  readonly secrets: readonly string[];
  readonly rpcUrl: string;
  readonly apiKey: string;
  readonly wsUrl: string;
  readonly poolId: string;
  readonly mintAddress: string;
  readonly projectRoot: string;
  readonly outDir: string;
  readonly limits: PaperCoordinatorLimits;
  readonly plan: PaperSingleCandidatePlan;
  readonly planJson: string;
  readonly planDigestSha256: string;
}): Promise<PaperSingleCandidateDiagnosticResult> {
  const { deps, out, redact, poolId, mintAddress, outDir, limits, plan, planDigestSha256 } = ctx;
  const clock = deps.clock ?? (() => Date.now());
  out(`[LIVE] ${LIVE_APPROVAL_STATUS}`);
  out(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
  out("[LIVE] Configuration loaded (values not shown).");

  // Reserve the new output directory before any request (refuses an existing one).
  mkdirSync(path.dirname(outDir), { recursive: true });
  mkdirSync(outDir);
  mkdirSync(path.join(outDir, EXCHANGE_EVIDENCE_DIR));
  const writer = sealedWriter(outDir, ctx.secrets);

  // Response evidence: written as each dispatched request completes (bounded by the session).
  const exchangeIndex: Record<string, unknown>[] = [];
  const captureFailures: string[] = [];
  const onRequestExchange = (e: PaperRequestExchangeEvidence) => {
    const rel = exchangeEvidencePath(e.entry.seq);
    try {
      const record = exchangeRecord(e, writer.redact);
      const meta = writer.writeJson(rel, record, "RESPONSE");
      exchangeIndex.push({
        seq: record.seq,
        file: rel,
        sha256: meta.sha256,
        lane: record.lane,
        owner: record.owner,
        purpose: record.purpose,
        rpcMethod: record.request.rpcMethod,
        httpStatus: record.httpStatus,
        error: record.error,
        bodyState: record.response.bodyState,
        completeEvidence: record.response.completeEvidence,
        receivedBytesSha256: record.response.receivedBytesSha256,
        bodyRedacted: record.response.bodyRedacted,
      });
    } catch (err) {
      captureFailures.push(redact(`${rel}: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  const wsLog: WsObservationLog = {
    transportsCreated: 0,
    retainedBytes: 0,
    dropped: 0,
    observations: [],
  };
  const wsCaps = {
    maxEntries:
      limits.flow.maxWsMessages +
      limits.flow.maxWsControlFrames +
      2 * limits.flow.maxKeepalivePings +
      8 * (limits.flow.maxReconnects + 1),
    maxRetainedBytes: limits.flow.maxWsMessageBytes,
  };

  const marketResponses: {
    readonly receivedAtMs: number | null;
    readonly response: unknown;
    readonly result: {
      readonly ok: boolean;
      readonly reason?: string;
      readonly provenance?: unknown;
    };
  }[] = [];
  let report: PaperCoordinatorReport | null = null;
  let failure: string | null = null;
  let coordinator: PaperSingleCandidateCoordinator | null = null;
  try {
    coordinator = new PaperSingleCandidateCoordinator({
      executionContext: "PAPER_SIMULATION",
      target: { poolId, mintAddress },
      transports: {
        fetchFn: deps.fetchFn ?? globalThis.fetch,
        createWebSocketTransport: () => {
          const inner = deps.createWebSocketTransport
            ? deps.createWebSocketTransport(ctx.wsUrl)
            : new WsWebSocketTransport(ctx.wsUrl);
          return observeWebSocket(
            inner,
            ++wsLog.transportsCreated,
            wsLog,
            wsCaps,
            clock,
            () => coordinator?.getFlowEpochState() ?? null,
            writer.redact,
          );
        },
      },
      endpoints: {
        solanaRpcUrl: ctx.rpcUrl,
        rugCheckApiUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.rugCheckApiUrl,
        solanaTrackerApiUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.solanaTrackerApiUrl,
        marketUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(mintAddress),
      },
      credentials: { solanaTrackerApiKey: ctx.apiKey },
      market: {
        // The strict parser, with every response and outcome recorded for offline revalidation.
        parse: (json, target, receivedAtMs) => {
          const result: DexScreenerMarketParseResult = parseDexScreenerTokenPairs(
            json,
            target,
            receivedAtMs ?? null,
          );
          marketResponses.push({
            receivedAtMs: receivedAtMs ?? null,
            response: json,
            result: result.ok
              ? { ok: true, provenance: result.provenance }
              : { ok: false, reason: result.reason },
          });
          return result.ok ? { pool: result.pool, spot: result.spot } : null;
        },
      },
      scannerConfig: CANDIDATE_SCANNER_DEFAULTS,
      lpEvidenceOrigin: "CAPTURED_RPC",
      limits,
      clock: deps.clock,
      timers: deps.timers,
      onRequestExchange,
    });
    const onAbort = () => coordinator?.stop("OPERATOR_INTERRUPT");
    if (deps.signal?.aborted) {
      coordinator.stop("OPERATOR_INTERRUPT");
    } else {
      deps.signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
      report = await coordinator.start();
    } finally {
      deps.signal?.removeEventListener("abort", onAbort);
    }
  } catch (err) {
    // The first failure cause is kept (redacted); the stop code remains readable.
    failure = redact(err instanceof Error ? err.message : String(err));
    coordinator?.stop(`RUNNER_FAILURE:${failure}`);
  }

  // ------------------------------------------------------------------------------------------
  // Seal successful and failed runs alike, after bounded cleanup.
  // ------------------------------------------------------------------------------------------
  const status = coordinator?.getStatus() ?? null;
  const session = coordinator?.getSessionStatus() ?? null;
  const flow = coordinator?.getFlowStatus() ?? null;
  const decisions = status?.decisions ?? [];
  const stopReason = redact(
    report?.stopReason ?? status?.stopReason ?? `RUNNER_FAILURE:${failure ?? "UNKNOWN"}`,
  );
  const ledgerSeqs = (session?.ledger ?? []).map((e) => e.seq);
  const recordedSeqs = new Set(exchangeIndex.map((x) => x.seq as number));
  const missingExchangeSeqs = ledgerSeqs.filter((s) => !recordedSeqs.has(s));
  const bodyStates = (state: string) => exchangeIndex.filter((x) => x.bodyState === state).length;
  const decisionInputs = coordinator?.getDecisionInputs() ?? [];
  const evidenceComplete =
    missingExchangeSeqs.length === 0 && captureFailures.length === 0 && wsLog.dropped === 0;
  const summary = {
    stopReason,
    failure,
    flowQualification: {
      refreshesPublished: flow?.refreshesPublished ?? 0,
      refreshesAttempted: flow?.refreshesAttempted ?? 0,
      reconnects: flow?.reconnects ?? 0,
      flowStopReason: flow?.stopReason ?? null,
      decisionsWithQualifiedFlow: decisions.filter((d) => d.flowCutoffAgeMs !== null).length,
      qualificationKinds: [...new Set((flow?.snapshots ?? []).map((s) => s.qualificationKind))],
    },
    strategyAcceptance: {
      outcome:
        stopReason === "ENTRY_CONFIRMED_NO_EXECUTION"
          ? "ENTRY_CONFIRMED_NO_EXECUTION"
          : "NOT_CONFIRMED",
      decisions: decisions.length,
      armed: decisions.filter((d) => d.action === "ARMED").length,
      disarms: status?.disarms.length ?? 0,
      lastOutcome: decisions.at(-1)?.outcome ?? decisions.at(-1)?.kind ?? null,
      executed: "NONE (decision-only: no buy, no position)",
    },
    requests: {
      total: session?.httpAttempts ?? 0,
      byLane: session?.attemptsByLane ?? null,
      refusalsByReason: session?.refusalsByReason ?? null,
    },
    evidence: {
      complete: evidenceComplete,
      exchangesRecorded: exchangeIndex.length,
      ledgerEntries: ledgerSeqs.length,
      missingExchangeSeqs,
      bodies: {
        complete: bodyStates("COMPLETE"),
        partial: bodyStates("PARTIAL_OVERFLOW"),
        notRead: bodyStates("NOT_READ"),
      },
      captureFailures: captureFailures.length,
      decisionInputsRecorded: decisionInputs.length,
      wsObservations: wsLog.observations.length,
      wsObservationsDropped: wsLog.dropped,
    },
  };
  const snapshotResults = (flow?.snapshots ?? []).map((s) => ({
    summary: s,
    reconciliation: coordinator?.getFlowSnapshotResult(s.id) ?? null,
  }));
  const files: Record<
    Exclude<(typeof CORE_EVIDENCE_FILES)[number], "plan.json" | "evidence-manifest.json">,
    unknown
  > = {
    "report.json": {
      planDigestSha256,
      stopReason,
      failure,
      coordinator: status,
      flowReport: report?.flow ?? null,
    },
    "summary.json": summary,
    "request-ledger.json": session,
    "request-exchanges.json": {
      note: "One file per dispatched request. receivedBytesSha256 is of the original response bytes (a partial body: the retained prefix only); manifest digests are of the sanitized files.",
      exchanges: [...exchangeIndex].sort((a, b) => (a.seq as number) - (b.seq as number)),
      missingExchangeSeqs,
      captureFailures,
    },
    "decisions.json": decisions,
    "decision-inputs.json": {
      note: "The flow and security inputs each decision consumed, recorded when read; they remain here after the cache or flow snapshot was replaced or retired.",
      intakeSecurityReads: coordinator?.getIntakeSecurityReads() ?? [],
      securityRefreshes: coordinator?.getSecurityRefreshRequests() ?? [],
      decisions: decisionInputs,
    },
    "disarms.json": status?.disarms ?? [],
    "market-responses.json": marketResponses,
    "security-evidence.json": {
      evidence: coordinator?.getSecurityEvidence() ?? null,
      cache: coordinator?.getCacheStatus() ?? null,
      loader: coordinator?.getLoaderStatus() ?? null,
    },
    "flow-evidence.json": {
      status: flow,
      snapshots: snapshotResults,
      recordedGaps: coordinator?.getFlowRecordedGaps() ?? [],
      epochState: coordinator?.getFlowEpochState() ?? null,
    },
    "ws-observations.json": {
      transportsCreated: wsLog.transportsCreated,
      caps: wsCaps,
      retainedBytes: wsLog.retainedBytes,
      dropped: wsLog.dropped,
      observations: wsLog.observations,
    },
  };
  writer.writeText("plan.json", ctx.planJson, "EVIDENCE");
  for (const name of CORE_EVIDENCE_FILES) {
    if (name === "plan.json" || name === "evidence-manifest.json") continue;
    writer.writeJson(name, files[name], name === "report.json" ? "REPORT" : "EVIDENCE");
  }
  const reportMeta = writer.entries.find((m) => m.path === "report.json")!;
  const manifest = {
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    poolId,
    mintAddress,
    generatedAtIso: new Date(clock()).toISOString(),
    planDigestSha256,
    approval: LIVE_APPROVAL_STATUS,
    digestScope:
      "sha256 and bytes are of the sanitized files as written; each exchange file also records receivedBytesSha256 of the original response bytes.",
    reportFile: { path: "report.json", sha256: reportMeta.sha256, bytes: reportMeta.bytes },
    files: [...writer.entries].sort((a, b) => a.path.localeCompare(b.path)),
    requests: session?.ledger ?? [],
  };
  const manifestMeta = writer.writeJson("evidence-manifest.json", manifest, "EVIDENCE");
  out(`[LIVE] Stop reason: ${stopReason}`);
  if (!evidenceComplete) {
    out(
      `[LIVE] Evidence INCOMPLETE: ${missingExchangeSeqs.length} missing exchange(s), ${captureFailures.length} capture failure(s), ${wsLog.dropped} dropped WebSocket observation(s)`,
    );
  }
  out(
    `[LIVE] Evidence sealed: ${path.relative(ctx.projectRoot, outDir)} (manifest sha256 ${manifestMeta.sha256})`,
  );
  return {
    mode: "LIVE",
    plan,
    planDigestSha256,
    outDir,
    stopReason,
    manifestDigestSha256: manifestMeta.sha256,
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);

/** A manifest path must be relative, forward-slashed and stay inside the run directory. */
function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) return false; // also excludes backslashes, colons and NUL
  if (p.startsWith("/") || path.isAbsolute(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Offline INTEGRITY verification of a sealed run (fails closed). Checks the manifest's structure,
 * that every required core entry is listed, that each listed path is safe, unique, present and a
 * regular file with the recorded size and SHA-256, that the report reference matches both its
 * entry and its file, that the plan digest matches the sealed plan and the report, that every
 * response file is indexed, and that nothing unlisted exists (recursively). It does not replay or
 * re-validate decisions or strategy.
 */
export function verifyPaperSingleCandidateEvidence(dir: string): {
  ok: boolean;
  scope: typeof VERIFY_SCOPE;
  problems: string[];
} {
  const problems: string[] = [];
  const done = () => ({ ok: problems.length === 0, scope: VERIFY_SCOPE, problems });
  const manifestPath = path.join(dir, "evidence-manifest.json");
  if (!existsSync(manifestPath)) {
    problems.push("MANIFEST_MISSING");
    return done();
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    problems.push("MANIFEST_INVALID_JSON");
    return done();
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("MANIFEST_INVALID");
    return done();
  }
  if (manifest.kind !== MANIFEST_KIND) problems.push("MANIFEST_KIND_INVALID");
  if (manifest.manifestVersion !== MANIFEST_VERSION) problems.push("MANIFEST_VERSION_INVALID");
  if (!isSha256(manifest.planDigestSha256)) problems.push("PLAN_DIGEST_INVALID");
  if (!Array.isArray(manifest.files)) {
    problems.push("MANIFEST_FILES_INVALID");
    return done();
  }

  const listed = new Map<string, { category: unknown; sha256: string; bytes: number }>();
  (manifest.files as unknown[]).forEach((raw, i) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (!isSafeRelativePath(f.path)) {
      problems.push(`INVALID_PATH:#${i}`);
      return;
    }
    const p = f.path;
    if (p === "evidence-manifest.json") {
      problems.push("MANIFEST_SELF_LISTED");
      return;
    }
    if (listed.has(p)) {
      problems.push(`DUPLICATE_PATH:${p}`);
      return;
    }
    const expectedCategory =
      p === "report.json"
        ? "REPORT"
        : p.startsWith(`${EXCHANGE_EVIDENCE_DIR}/`)
          ? "RESPONSE"
          : "EVIDENCE";
    if (f.category !== expectedCategory) problems.push(`INVALID_CATEGORY:${p}`);
    const digestOk = isSha256(f.sha256);
    const sizeOk = typeof f.bytes === "number" && Number.isSafeInteger(f.bytes) && f.bytes >= 0;
    if (!digestOk) problems.push(`INVALID_DIGEST:${p}`);
    if (!sizeOk) problems.push(`INVALID_SIZE:${p}`);
    listed.set(p, { category: f.category, sha256: String(f.sha256), bytes: Number(f.bytes) });
    const full = path.join(dir, ...p.split("/"));
    let isFile = false;
    try {
      isFile = lstatSync(full).isFile();
    } catch {
      problems.push(`MISSING:${p}`);
      return;
    }
    if (!isFile) {
      problems.push(`NOT_A_REGULAR_FILE:${p}`);
      return;
    }
    const buf = readFileSync(full);
    if (!digestOk || !sizeOk || buf.length !== f.bytes || sha256(buf) !== f.sha256) {
      problems.push(`MODIFIED:${p}`);
    }
  });
  for (const required of CORE_EVIDENCE_FILES) {
    if (required !== "evidence-manifest.json" && !listed.has(required)) {
      problems.push(`REQUIRED_ENTRY_MISSING:${required}`);
    }
  }

  // The report reference must match its manifest entry and the actual file.
  const rf = (manifest.reportFile ?? null) as Record<string, unknown> | null;
  if (!rf || typeof rf !== "object") {
    problems.push("REPORT_FILE_INVALID");
  } else {
    if (rf.path !== "report.json") problems.push("REPORT_FILE_PATH_INVALID");
    const entry = listed.get("report.json");
    if (!entry) problems.push("REPORT_NOT_LISTED");
    else if (rf.sha256 !== entry.sha256 || rf.bytes !== entry.bytes) {
      problems.push("REPORT_FILE_ENTRY_MISMATCH");
    }
    const reportPath = path.join(dir, "report.json");
    if (existsSync(reportPath)) {
      const buf = readFileSync(reportPath);
      if (buf.length !== rf.bytes || sha256(buf) !== rf.sha256) {
        problems.push("REPORT_FILE_DIGEST_MISMATCH");
      }
    }
  }

  // Plan-digest references: the sealed plan's bytes and the report's reference.
  const readJson = (name: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const planPath = path.join(dir, "plan.json");
  if (existsSync(planPath) && sha256(readFileSync(planPath)) !== manifest.planDigestSha256) {
    problems.push("PLAN_DIGEST_MISMATCH");
  }
  const reportJson = existsSync(path.join(dir, "report.json")) ? readJson("report.json") : null;
  if (reportJson && reportJson.planDigestSha256 !== manifest.planDigestSha256) {
    problems.push("REPORT_PLAN_DIGEST_MISMATCH");
  }

  // Every response file must be indexed, and every indexed file listed.
  const index = existsSync(path.join(dir, "request-exchanges.json"))
    ? readJson("request-exchanges.json")
    : null;
  const indexed = new Set(
    (Array.isArray(index?.exchanges) ? (index.exchanges as { file?: unknown }[]) : []).map((x) =>
      String(x.file),
    ),
  );
  for (const p of listed.keys()) {
    if (p.startsWith(`${EXCHANGE_EVIDENCE_DIR}/`) && !indexed.has(p)) {
      problems.push(`RESPONSE_NOT_INDEXED:${p}`);
    }
  }
  for (const p of indexed) if (!listed.has(p)) problems.push(`INDEXED_RESPONSE_NOT_LISTED:${p}`);

  // Nothing unlisted may exist (recursive; links and other non-regular entries are rejected).
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, ...(rel ? rel.split("/") : [])))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path.join(dir, ...childRel.split("/")));
      if (st.isDirectory()) walk(childRel);
      else if (!st.isFile()) problems.push(`UNEXPECTED_ENTRY:${childRel}`);
      else if (childRel !== "evidence-manifest.json" && !listed.has(childRel)) {
        problems.push(`UNLISTED:${childRel}`);
      }
    }
  };
  walk("");
  return done();
}

/** Read-only CLI integrity verification of a sealed run directory (no configuration, no network). */
export function runVerifyCli(dir: string, log: (line: string) => void = console.log): boolean {
  const result = verifyPaperSingleCandidateEvidence(path.resolve(dir));
  log(JSON.stringify(result, null, 2));
  return result.ok;
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("paper-single-candidate-diagnostic.ts") &&
  process.argv[2] === "--verify"
) {
  process.exit(runVerifyCli(process.argv[3] ?? "") ? 0 : 1);
} else if (process.argv[1] && process.argv[1].endsWith("paper-single-candidate-diagnostic.ts")) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  runPaperSingleCandidateDiagnostic(process.argv.slice(2), { signal: controller.signal }).catch(
    (err: unknown) => {
      // Live-path errors are already redacted when they reach here.
      console.error(
        "[PAPER_SINGLE_CANDIDATE_DIAGNOSTIC_ERROR]",
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    },
  );
}
