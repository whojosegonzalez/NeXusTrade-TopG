#!/usr/bin/env node
/**
 * NeXusTrade — Standalone Candidate Decision Diagnostic CLI
 *
 * Runs the single-target diagnostic acquisition and evaluation workflow.
 * Defaults to dry-run preflight; live network calls strictly require --live.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  CandidateDecisionDiagnostic,
  DEFAULT_CAPACITY_PROFILE,
  PAPER_ACTIVE_WINDOW_CAPACITY_PROFILE,
  SELECTABLE_PAPER_CAPACITY_PROFILES,
  resolvePaperCapacityProfileSelection,
  type PaperCapacityProfileId,
  DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES,
  DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES,
  validateRugCheckDiagnosticOptions,
} from "../candidate-scanner/CandidateDecisionDiagnostic.js";
import { isCanonicalSolanaBase58 } from "../candidate-scanner/LpScreeningBridge.js";

function loadEnvironment(): void {
  try {
    const rootEnv = path.resolve(process.cwd(), ".env");
    const parentEnv = path.resolve(process.cwd(), "..", ".env");
    if (existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    } else if (existsSync(parentEnv)) {
      process.loadEnvFile(parentEnv);
    }
  } catch {
    // Ignore if already loaded or unavailable
  }
}

export interface RugCheckCliOptIns {
  readonly rugCheckMaxResponseBytes: number | undefined;
  readonly overlapRugCheckWithMintPacing: boolean;
}

/**
 * Parses and validates the explicit RugCheck diagnostic opt-ins. Throws [CLI_INVALID_ARG] before any
 * network activity. Absent flags keep the defaults (shared 1 MiB ceiling, serial retrieval).
 */
export function parseRugCheckCliOptIns(values: Record<string, unknown>): RugCheckCliOptIns {
  const rawMax = values["rugcheck-max-bytes"];
  let rugCheckMaxResponseBytes: number | undefined;
  if (rawMax !== undefined) {
    if (typeof rawMax !== "string" || !/^[1-9][0-9]*$/.test(rawMax)) {
      throw new Error(
        `[CLI_INVALID_ARG] --rugcheck-max-bytes must be a positive integer byte count (got: "${String(rawMax)}")`,
      );
    }
    rugCheckMaxResponseBytes = Number(rawMax);
  }
  const rawOverlap = values["overlap-rugcheck"];
  if (rawOverlap !== undefined && rawOverlap !== true) {
    throw new Error(
      `[CLI_INVALID_ARG] --overlap-rugcheck is a flag and takes no value (got: "${String(rawOverlap)}")`,
    );
  }
  const overlapRugCheckWithMintPacing = rawOverlap === true;
  try {
    validateRugCheckDiagnosticOptions({ rugCheckMaxResponseBytes, overlapRugCheckWithMintPacing });
  } catch (err) {
    throw new Error(
      `[CLI_INVALID_ARG] ${err instanceof Error ? err.message.replace("[DIAGNOSTIC_INVALID_ARG] ", "") : String(err)}`,
    );
  }
  return { rugCheckMaxResponseBytes, overlapRugCheckWithMintPacing };
}

export async function runCandidateDecisionDiagnosticCli(
  rawArgs: string[] = process.argv.slice(2),
): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      options: {
        pool: { type: "string" },
        mint: { type: "string" },
        "rpc-url": { type: "string" },
        "out-dir": { type: "string" },
        paper: { type: "boolean" },
        live: { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
        "rugcheck-max-bytes": { type: "string" },
        "overlap-rugcheck": { type: "boolean" },
        "paper-active-window": { type: "boolean" },
        "paper-capacity-profile": { type: "string" },
      },
      // Strict parsing: a misspelled opt-in must fail rather than silently fall back to defaults.
      strict: true,
    }));
  } catch (err) {
    throw new Error(`[CLI_INVALID_ARG] ${err instanceof Error ? err.message : String(err)}`);
  }

  if (values.help) {
    console.log(`
NeXusTrade Candidate Decision Diagnostic CLI

Usage:
  node dist/scripts/candidate-decision-diagnostic.js --pool <POOL_ID> --mint <MINT_ADDRESS> [options]

Options:
  --pool <id>       Canonical Solana Base58 Raydium AMM v4 pool address (Required)
  --mint <address>  Canonical Solana Base58 candidate token mint address (Required)
  --rpc-url <url>   Solana RPC HTTP endpoint (Defaults to SOLANA_RPC_URL)
  --out-dir <path>  Target output directory for diagnostic report & manifest
  --paper           Run under PAPER_SIMULATION execution context (Default: false)
  --live            Authorize live HTTP/RPC network dispatches (Default: false)
  --dry-run         Execute zero-network preflight validation and exit (Default: false)
  --rugcheck-max-bytes <n>
                    OPT-IN: decoded-response ceiling for RUGCHECK_REPORT only, 1..${DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES}
                    (4 MiB). Default: shared ${DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES}-byte (1 MiB) ceiling. All other
                    purposes always keep 1 MiB. This is a response-byte ceiling, not a process memory limit.
  --overlap-rugcheck
                    OPT-IN: dispatch RUGCHECK_REPORT once validated LP evidence passes the unchanged 90% rule,
                    overlapping the pacing wait before CANDIDATE_MINT. May spend one RugCheck request before an
                    authority rejection; never admits a candidate. Default: serial after pre-admission.
  --paper-active-window
                    OPT-IN (requires --paper): qualify fully reconciled ACTIVE 60 s windows whose every in-window
                    signature was resolved by the stream decode path. Selects capacity profile
                    PAPER_ACTIVE_WINDOW_20_9: 20 HTTP attempts, 9 transaction retrievals (at most 2 drain
                    retrievals after the fixed 65 s nominal end), GET_SLOT within 5 s of that end, no retrieval
                    after GET_SLOT. Default runs keep DEFAULT_14_3 (14 attempts, 3 retrievals).
                    PAPER research only; provider-relative assumptions; not production completeness.
  --paper-capacity-profile <id>
                    OPT-IN (requires --paper and --paper-active-window): explicitly select a PAPER capacity
                    profile. Supported: ${Object.keys(SELECTABLE_PAPER_CAPACITY_PROFILES).join(", ")}.
                    PAPER_ACTIVE_WINDOW_23_12: 23 HTTP attempts, 12 transaction retrievals, queue ceiling 13; all
                    timing limits unchanged. Never selected by an environment variable.
  --help            Show this help text
`);
    return;
  }

  const poolId = typeof values.pool === "string" ? values.pool : "";
  const mintAddress = typeof values.mint === "string" ? values.mint : "";

  if (!poolId || !isCanonicalSolanaBase58(poolId)) {
    throw new Error(
      `[CLI_INVALID_ARG] Valid canonical --pool argument is required (got: "${String(values.pool)}")`,
    );
  }
  if (!mintAddress || !isCanonicalSolanaBase58(mintAddress)) {
    throw new Error(
      `[CLI_INVALID_ARG] Valid canonical --mint argument is required (got: "${String(values.mint)}")`,
    );
  }

  // Opt-ins are validated before the dry-run exit, environment loading, or any network activity.
  const rugCheckOptIns = parseRugCheckCliOptIns(values);
  const paperActiveWindowFlow = values["paper-active-window"] === true;
  if (paperActiveWindowFlow && values.paper !== true) {
    throw new Error("[CLI_INVALID_ARG] --paper-active-window requires --paper (PAPER_SIMULATION)");
  }
  const rawProfileSelection = values["paper-capacity-profile"];
  let selectedPaperProfile: ReturnType<typeof resolvePaperCapacityProfileSelection>;
  try {
    selectedPaperProfile = resolvePaperCapacityProfileSelection(rawProfileSelection, {
      paperActiveWindowFlow,
      executionContext: values.paper === true ? "PAPER_SIMULATION" : "PRODUCTION",
    });
  } catch (err) {
    throw new Error(
      `[CLI_INVALID_ARG] --paper-capacity-profile: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isPaper = values.paper === true;
  const isLive = values.live === true;
  const isDryRun = values["dry-run"] === true || !isLive;
  const outDir = typeof values["out-dir"] === "string" ? values["out-dir"] : undefined;

  console.log("===============================================================================");
  console.log("            NEXUSTRADE: STANDALONE CANDIDATE DECISION DIAGNOSTIC               ");
  console.log("===============================================================================");
  console.log(`Target Pool ID:     ${poolId}`);
  console.log(`Candidate Mint:     ${mintAddress}`);
  console.log(
    `Execution Mode:     ${isPaper ? "PAPER_SIMULATION" : "PRODUCTION (Fail-Closed Default)"}`,
  );
  console.log(`Live Dispatches:    ${isLive ? "AUTHORIZED" : "DISABLED (Dry-Run Only)"}`);
  console.log(`Output Directory:   ${outDir ?? "Default (data/research/diagnostics/...)"}`);
  console.log(
    `RugCheck Ceiling:   ${
      rugCheckOptIns.rugCheckMaxResponseBytes !== undefined
        ? `${rugCheckOptIns.rugCheckMaxResponseBytes} decoded bytes (OPT-IN, RUGCHECK_REPORT only)`
        : `${DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES} decoded bytes (default, shared)`
    }`,
  );
  console.log(
    `RugCheck Retrieval: ${
      rugCheckOptIns.overlapRugCheckWithMintPacing
        ? "OVERLAPPED with CANDIDATE_MINT pacing after LP >= 90% (OPT-IN)"
        : "SERIAL after pre-admission passes (default)"
    }`,
  );
  console.log(
    `Other HTTP Ceiling: ${DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES} decoded bytes per response`,
  );
  console.log(
    `Flow Policy:        ${
      paperActiveWindowFlow
        ? "QUIET + ACTIVE-WINDOW PAPER qualification (OPT-IN)"
        : "QUIET-WINDOW PAPER qualification only (default)"
    }`,
  );
  const capacityProfile =
    selectedPaperProfile ??
    (paperActiveWindowFlow ? PAPER_ACTIVE_WINDOW_CAPACITY_PROFILE : DEFAULT_CAPACITY_PROFILE);
  console.log(
    `Capacity Profile:   ${capacityProfile.id} (${capacityProfile.maxTotalRequests} HTTP attempts, ${capacityProfile.maxTransactionRetrievals} transaction retrievals, queue ceiling ${capacityProfile.queueCeiling}${
      capacityProfile.cutoffDispatchWindowMs !== null
        ? `, <= ${capacityProfile.maxDrainRetrievals} drain retrievals, GET_SLOT <= ${capacityProfile.cutoffDispatchWindowMs} ms after the fixed ${capacityProfile.nominalObservationMs} ms nominal observation end, no retrieval after GET_SLOT`
        : ""
    })`,
  );
  console.log("===============================================================================");

  if (isDryRun) {
    console.log("[Dry-Run Preflight] Live execution flag (--live) omitted or --dry-run requested.");
    console.log("[Dry-Run Preflight] Validated canonical pool and token mint identities.");
    console.log(
      `[Dry-Run Preflight] Maximum request ledger: ${capacityProfile.maxTotalRequests} attempts max under ${capacityProfile.id} (Quiet path: <= 11 attempts).`,
    );
    console.log(
      "[Dry-Run Preflight] Unchanged limits: 2,500 ms RPC pacing, 10 s per request, 90 s overall, 15,000 ms evidence freshness, 1 request per purpose, no retries.",
    );
    if (rugCheckOptIns.overlapRugCheckWithMintPacing) {
      console.log(
        "[Dry-Run Preflight] Overlap trade-off: one RugCheck request may be spent before an authority rejection; overlap never admits a candidate.",
      );
    }
    console.log(
      "[Dry-Run Preflight] Exiting cleanly with code 0 without dispatching network calls or writing canonical state.",
    );
    return;
  }

  // Environment (RPC URL, API keys) is loaded only after the zero-network dry-run exit.
  loadEnvironment();

  const rpcUrl =
    typeof values["rpc-url"] === "string"
      ? values["rpc-url"]
      : (process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899");
  const solanaTrackerApiKey = process.env.SOLANA_TRACKER_API_KEY;

  const diagnostic = new CandidateDecisionDiagnostic({
    poolId,
    mintAddress,
    rpcUrl,
    outDir,
    executionContext: isPaper ? "PAPER_SIMULATION" : "PRODUCTION",
    isLive: true,
    solanaTrackerApiKey,
    rugCheckMaxResponseBytes: rugCheckOptIns.rugCheckMaxResponseBytes,
    overlapRugCheckWithMintPacing: rugCheckOptIns.overlapRugCheckWithMintPacing,
    paperActiveWindowFlow,
    ...(selectedPaperProfile
      ? { paperCapacityProfile: selectedPaperProfile.id as PaperCapacityProfileId }
      : {}),
  });

  const result = await diagnostic.run();

  console.log("\n===============================================================================");
  console.log(`Diagnostic Completed: ${result.ok ? "SUCCESS" : "REJECTED / FAILED"}`);
  console.log(`Status:               ${result.status}`);
  console.log(`Message:              ${result.message}`);
  console.log(
    `Requests Dispatched:  ${result.ledger.totalAttempts} / ${result.capacityProfile?.maxTotalRequests ?? capacityProfile.maxTotalRequests} max (${result.capacityProfile?.id ?? capacityProfile.id})`,
  );
  if (result.outDir) {
    console.log(`Report Artifacts:     ${result.outDir}`);
  }
  console.log("===============================================================================");
}

if (process.argv[1] && process.argv[1].endsWith("candidate-decision-diagnostic.ts")) {
  runCandidateDecisionDiagnosticCli().catch((err) => {
    console.error("[FATAL_DIAGNOSTIC_ERROR]", err);
    process.exit(1);
  });
}
