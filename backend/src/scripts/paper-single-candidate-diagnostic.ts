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
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import type { PaperRequestSessionTimers } from "../candidate-scanner/PaperRequestSession.js";
import { deepRedactSensitiveObject } from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
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
    readonly solanaTrackerCredential: "SOLANA_TRACKER_API_KEY (configuration; never printed)";
    readonly market: string;
  };
  readonly limits: PaperCoordinatorLimits;
  readonly allocation: RequestAllocation;
  readonly scannerConfig: typeof CANDIDATE_SCANNER_DEFAULTS;
  readonly stopConditions: readonly string[];
  readonly boundaries: readonly string[];
  readonly evidenceFiles: readonly string[];
}

const EVIDENCE_FILES = [
  "plan.json",
  "report.json",
  "summary.json",
  "request-ledger.json",
  "decisions.json",
  "disarms.json",
  "market-responses.json",
  "security-evidence.json",
  "flow-evidence.json",
  "evidence-manifest.json",
] as const;

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
      solanaTrackerCredential: "SOLANA_TRACKER_API_KEY (configuration; never printed)",
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

/** Secrets to redact from anything persisted: the key, the RPC URL and its credential parts. */
function secretsFrom(rpcUrl: string, apiKey: string): string[] {
  const secrets = new Set<string>([apiKey, rpcUrl]);
  try {
    const u = new URL(rpcUrl);
    if (u.username) secrets.add(u.username);
    if (u.password) secrets.add(u.password);
    for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
    for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
  } catch {
    // An unparsable URL is rejected before use; nothing more to collect.
  }
  return [...secrets].filter((s) => s.length > 0);
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
  const secrets = secretsFrom(rpcUrl, apiKey);
  const wsUrl = rpcUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  log(`[LIVE] ${LIVE_APPROVAL_STATUS}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
  log("[LIVE] Configuration loaded (values not shown).");

  // Reserve the new output directory before any request (refuses an existing one).
  mkdirSync(path.dirname(outDir), { recursive: true });
  mkdirSync(outDir);

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
        createWebSocketTransport: () =>
          deps.createWebSocketTransport
            ? deps.createWebSocketTransport(wsUrl)
            : new WsWebSocketTransport(wsUrl),
      },
      endpoints: {
        solanaRpcUrl: rpcUrl,
        rugCheckApiUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.rugCheckApiUrl,
        solanaTrackerApiUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.solanaTrackerApiUrl,
        marketUrl: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(mintAddress),
      },
      credentials: { solanaTrackerApiKey: apiKey },
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
    failure = err instanceof Error ? err.message : String(err);
    coordinator?.stop(`RUNNER_FAILURE:${failure}`);
  }

  // ------------------------------------------------------------------------------------------
  // Seal successful and failed runs alike, after bounded cleanup.
  // ------------------------------------------------------------------------------------------
  const clock = deps.clock ?? (() => Date.now());
  const status = coordinator?.getStatus() ?? null;
  const session = coordinator?.getSessionStatus() ?? null;
  const flow = coordinator?.getFlowStatus() ?? null;
  const decisions = status?.decisions ?? [];
  const stopReason = report?.stopReason ?? status?.stopReason ?? `RUNNER_FAILURE:${failure}`;
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
  };
  const snapshotResults = (flow?.snapshots ?? []).map((s) => ({
    summary: s,
    reconciliation: coordinator?.getFlowSnapshotResult(s.id) ?? null,
  }));
  const files: Record<(typeof EVIDENCE_FILES)[number], unknown> = {
    "plan.json": plan,
    "report.json": {
      planDigestSha256,
      stopReason,
      failure,
      coordinator: status,
      flowReport: report?.flow ?? null,
    },
    "summary.json": summary,
    "request-ledger.json": session,
    "decisions.json": decisions,
    "disarms.json": status?.disarms ?? [],
    "market-responses.json": marketResponses,
    "security-evidence.json": {
      evidence: coordinator?.getSecurityEvidence() ?? null,
      cache: coordinator?.getCacheStatus() ?? null,
      loader: coordinator?.getLoaderStatus() ?? null,
    },
    "flow-evidence.json": { status: flow, snapshots: snapshotResults },
    "evidence-manifest.json": null,
  };
  const manifestFiles: {
    path: string;
    category: "REPORT" | "EVIDENCE";
    sha256: string;
    bytes: number;
  }[] = [];
  const write = (name: string, data: unknown) => {
    const content = serializeJsonPreservingBigInts(deepRedactSensitiveObject(data, secrets));
    for (const secret of secrets) {
      if (content.includes(secret))
        throw new Error(`[SEAL_REFUSED] a secret would be persisted in ${name}`);
    }
    writeFileSync(path.join(outDir, name), content, { encoding: "utf8", flag: "wx" });
    const bytes = Buffer.byteLength(content, "utf8");
    return { sha256: sha256(content), bytes };
  };
  for (const name of EVIDENCE_FILES) {
    if (name === "evidence-manifest.json") continue;
    const meta = write(name, files[name]);
    manifestFiles.push({
      path: name,
      category: name === "report.json" ? "REPORT" : "EVIDENCE",
      ...meta,
    });
  }
  const reportMeta = manifestFiles.find((m) => m.path === "report.json")!;
  const manifest = {
    poolId,
    mintAddress,
    generatedAtIso: new Date(clock()).toISOString(),
    planDigestSha256,
    approval: LIVE_APPROVAL_STATUS,
    reportFile: { path: "report.json", sha256: reportMeta.sha256, bytes: reportMeta.bytes },
    files: manifestFiles,
    requests: session?.ledger ?? [],
  };
  const manifestMeta = write("evidence-manifest.json", manifest);
  log(`[LIVE] Stop reason: ${stopReason}`);
  log(
    `[LIVE] Evidence sealed: ${path.relative(projectRoot, outDir)} (manifest sha256 ${manifestMeta.sha256})`,
  );
  return {
    mode,
    plan,
    planDigestSha256,
    outDir,
    stopReason,
    manifestDigestSha256: manifestMeta.sha256,
  };
}

/** Offline revalidation of a sealed run: every listed file present, unchanged, and nothing extra. */
export function verifyPaperSingleCandidateEvidence(dir: string): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const manifestPath = path.join(dir, "evidence-manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, problems: ["MANIFEST_MISSING"] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files?: { path: string; sha256: string; bytes: number }[];
    reportFile?: { path: string; sha256: string; bytes: number };
  };
  const listed = new Set<string>(["evidence-manifest.json"]);
  for (const f of manifest.files ?? []) {
    listed.add(f.path);
    const full = path.join(dir, f.path);
    if (!existsSync(full)) {
      problems.push(`MISSING:${f.path}`);
      continue;
    }
    const buf = readFileSync(full);
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) problems.push(`MODIFIED:${f.path}`);
  }
  if (!manifest.reportFile || !listed.has(manifest.reportFile.path))
    problems.push("REPORT_NOT_LISTED");
  for (const name of readdirSync(dir)) if (!listed.has(name)) problems.push(`UNLISTED:${name}`);
  return { ok: problems.length === 0, problems };
}

/** Read-only CLI verification of a sealed run directory (no configuration, no network). */
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
      console.error(
        "[PAPER_SINGLE_CANDIDATE_DIAGNOSTIC_ERROR]",
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    },
  );
}
