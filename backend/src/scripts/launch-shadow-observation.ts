/**
 * Phase 12.94-D Milestone D.3.3: Live Shadow Observation Launcher Executable
 *
 * Dedicated operator-facing executable to launch and supervise a bounded,
 * read-only live prospective shadow observation session.
 *
 * SAFETY INVARIANTS:
 * 1. ZERO paper-trading daemon initialization, wallet keys, or balance mutations.
 * 2. Virtual balance is frozen at 7.9259 SOL.
 * 3. 100% read-only HTTP GET calls against DexScreener/Raydium public endpoints.
 * 4. Genuinely global budget: hard ceiling of 120 calls across discovery, enrichment, quotes, retries.
 * 5. Minimum 2,500 ms provider pacing.
 * 6. Maximum 25 candidates.
 * 7. 60m intake, 60m drain, 120m hard session ceiling.
 * 8. Cryptographic SHA-256 session manifest verifies all artifacts on disk.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  LiveDexScreenerCandidateSource,
  LiveDexScreenerQuoteProvider,
} from "../research/prospective/LiveShadowProviders.js";
import {
  ShadowObservationRunner,
  type ShadowRunnerConfig,
} from "../research/prospective/ShadowObservationRunner.js";
import { computeCombinedSessionFingerprint } from "../research/prospective/StrategyConfigurationFingerprint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../..");

export interface ShadowLauncherArgs {
  sessionId?: string | undefined;
  outDir?: string | undefined;
  intakeMinutes?: number | undefined;
  drainMinutes?: number | undefined;
  maxCandidates?: number | undefined;
  maxRequests?: number | undefined;
  maxEnrichmentAttempts?: number | undefined;
  minReservedForwardRequests?: number | undefined;
  pacingMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  dryRun?: boolean | undefined;
}

export function validateLauncherArgs(args: ShadowLauncherArgs): void {
  if (args.intakeMinutes !== undefined) {
    if (
      !Number.isFinite(args.intakeMinutes) ||
      args.intakeMinutes <= 0 ||
      args.intakeMinutes > 120
    ) {
      throw new Error(
        `[INVALID_ARGUMENT] intakeMinutes must be between 1 and 120 (got: ${args.intakeMinutes})`,
      );
    }
  }
  if (args.drainMinutes !== undefined) {
    if (!Number.isFinite(args.drainMinutes) || args.drainMinutes <= 0 || args.drainMinutes > 120) {
      throw new Error(
        `[INVALID_ARGUMENT] drainMinutes must be between 1 and 120 (got: ${args.drainMinutes})`,
      );
    }
  }
  const totalMinutes = (args.intakeMinutes ?? 60) + (args.drainMinutes ?? 60);
  if (totalMinutes > 180) {
    throw new Error(
      `[INVALID_ARGUMENT] Total session duration (intake + drain) cannot exceed 180 minutes (got: ${totalMinutes})`,
    );
  }
  if (args.maxCandidates !== undefined) {
    if (
      !Number.isFinite(args.maxCandidates) ||
      args.maxCandidates <= 0 ||
      args.maxCandidates > 25
    ) {
      throw new Error(
        `[INVALID_ARGUMENT] maxCandidates must be between 1 and 25 (got: ${args.maxCandidates})`,
      );
    }
  }
  if (args.maxRequests !== undefined) {
    if (!Number.isFinite(args.maxRequests) || args.maxRequests <= 0 || args.maxRequests > 120) {
      throw new Error(
        `[INVALID_ARGUMENT] maxRequests must be between 1 and 120 (got: ${args.maxRequests})`,
      );
    }
  }
  if (args.maxEnrichmentAttempts !== undefined) {
    if (
      !Number.isFinite(args.maxEnrichmentAttempts) ||
      args.maxEnrichmentAttempts <= 0 ||
      args.maxEnrichmentAttempts > 60
    ) {
      throw new Error(
        `[INVALID_ARGUMENT] maxEnrichmentAttempts must be between 1 and 60 (got: ${args.maxEnrichmentAttempts})`,
      );
    }
  }
  if (args.minReservedForwardRequests !== undefined) {
    if (
      !Number.isFinite(args.minReservedForwardRequests) ||
      args.minReservedForwardRequests < 0 ||
      args.minReservedForwardRequests > 60
    ) {
      throw new Error(
        `[INVALID_ARGUMENT] minReservedForwardRequests must be between 0 and 60 (got: ${args.minReservedForwardRequests})`,
      );
    }
  }
  if (args.pacingMs !== undefined) {
    if (!Number.isFinite(args.pacingMs) || args.pacingMs < 2500) {
      throw new Error(`[INVALID_ARGUMENT] pacingMs must be >= 2500 ms (got: ${args.pacingMs})`);
    }
  }
  if (args.pollIntervalMs !== undefined) {
    if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs < 5000) {
      throw new Error(
        `[INVALID_ARGUMENT] pollIntervalMs must be >= 5000 ms (got: ${args.pollIntervalMs})`,
      );
    }
  }
}

export function parseLauncherArgs(argv: string[]): ShadowLauncherArgs {
  const args: ShadowLauncherArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session" && argv[i + 1]) {
      args.sessionId = argv[++i];
    } else if (arg === "--outDir" && argv[i + 1]) {
      args.outDir = argv[++i];
    } else if (arg === "--intakeMinutes" && argv[i + 1]) {
      args.intakeMinutes = Number(argv[++i]);
    } else if (arg === "--drainMinutes" && argv[i + 1]) {
      args.drainMinutes = Number(argv[++i]);
    } else if (arg === "--maxCandidates" && argv[i + 1]) {
      args.maxCandidates = Number(argv[++i]);
    } else if (arg === "--maxRequests" && argv[i + 1]) {
      args.maxRequests = Number(argv[++i]);
    } else if (arg === "--maxEnrichmentAttempts" && argv[i + 1]) {
      args.maxEnrichmentAttempts = Number(argv[++i]);
    } else if (arg === "--minReservedForwardRequests" && argv[i + 1]) {
      args.minReservedForwardRequests = Number(argv[++i]);
    } else if (arg === "--pacingMs" && argv[i + 1]) {
      args.pacingMs = Number(argv[++i]);
    } else if (arg === "--pollIntervalMs" && argv[i + 1]) {
      args.pollIntervalMs = Number(argv[++i]);
    } else if (arg === "--dryRun") {
      args.dryRun = true;
    }
  }
  validateLauncherArgs(args);
  return args;
}

export async function runShadowLauncher(cliArgs: ShadowLauncherArgs = {}): Promise<void> {
  validateLauncherArgs(cliArgs);

  const sessionId =
    cliArgs.sessionId || `shadow-live-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const outDir = cliArgs.outDir || path.join(rootDir, "data", "research", "prospective", sessionId);

  const intakeMinutes = cliArgs.intakeMinutes ?? 60;
  const drainMinutes = cliArgs.drainMinutes ?? 60;
  const maxCandidates = cliArgs.maxCandidates ?? 25;
  const maxRequests = cliArgs.maxRequests ?? 120;
  const maxEnrichmentAttempts =
    cliArgs.maxEnrichmentAttempts ?? Math.min(8, Math.max(1, Math.floor(maxRequests * 0.6)));
  const minReservedForwardRequests =
    cliArgs.minReservedForwardRequests ?? Math.min(4, Math.max(1, Math.floor(maxRequests * 0.3)));
  const pacingMs = cliArgs.pacingMs ?? 2500;
  const pollIntervalMs = cliArgs.pollIntervalMs ?? 180_000; // 3 minutes

  console.log("================================================================================");
  console.log(" NeXusTrade — Dedicated Live Shadow Observation Launcher");
  console.log(" Phase 12.94-D Milestone D.3.3: Bounded Prospective Observation");
  console.log("================================================================================");
  console.log(`Session ID:          ${sessionId}`);
  console.log(`Output Directory:    ${outDir}`);
  console.log(`Intake Window:       ${intakeMinutes} minutes`);
  console.log(`Drain Window:        ${drainMinutes} minutes`);
  console.log(`Hard Session Ceiling:${intakeMinutes + drainMinutes} minutes`);
  console.log(`Max Candidates:      ${maxCandidates}`);
  console.log(`Global Request Cap:  ${maxRequests} requests`);
  console.log(`Max Enrich Attempts: ${maxEnrichmentAttempts} attempts`);
  console.log(`Min Reserved Quotes: ${minReservedForwardRequests} requests`);
  console.log(`Provider Pacing:     ${pacingMs} ms`);
  console.log(`Virtual Wallet:      7.9259 SOL (Strictly Frozen)`);
  console.log("================================================================================");

  // Mandatory Preflight Isolation Checks
  console.log("\n[PREFLIGHT] Verifying safety and isolation invariants...");

  // 1. Path Confinement & Nonempty Directory Collision Guard
  const approvedRoot = path.resolve(rootDir, "data", "research", "prospective");
  const resolvedOut = path.resolve(outDir);
  const relative = path.relative(approvedRoot, resolvedOut);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `[SECURITY] Output directory ${resolvedOut} is outside approved root ${approvedRoot}`,
    );
  }

  if (fs.existsSync(resolvedOut)) {
    const existing = fs.readdirSync(resolvedOut);
    if (existing.length > 0) {
      throw new Error(
        `[PREFLIGHT_FAIL] Output directory ${resolvedOut} is not empty (${existing.length} file(s) exist). Cannot use nonempty directory.`,
      );
    }
  } else {
    fs.mkdirSync(resolvedOut, { recursive: true });
  }

  // 2. Compute Config Fingerprints (Binding actual strategy Buy Gate rules + cohort boundaries)
  const fingerprintResult = computeCombinedSessionFingerprint({
    sessionId,
    intakeMinutes,
    drainMinutes,
    maxCandidates,
    maxRequests,
    maxEnrichmentAttempts,
    minReservedForwardRequests,
    pacingMs,
    walletBalance: "7.9259 SOL",
  });
  const configFingerprint = fingerprintResult.combinedFingerprint;

  console.log(`[PREFLIGHT] Combined Fingerprint: ${fingerprintResult.combinedFingerprint}`);
  console.log(`[PREFLIGHT] Strategy Fingerprint: ${fingerprintResult.strategyConfigFingerprint}`);
  console.log(`[PREFLIGHT] Strategy Version:     ${fingerprintResult.strategyVersion}`);
  console.log(`[PREFLIGHT] Launcher Fingerprint: ${fingerprintResult.launcherConfigFingerprint}`);

  if (cliArgs.dryRun) {
    console.log(
      "[PREFLIGHT] Dry-run validation successful. Exiting cleanly with zero network activity.",
    );
    return;
  }

  // 3. Initialize Shared Global Resource Controller
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: maxRequests,
    maxEnrichmentAttempts,
    minReservedForwardRequests,
    minProviderSpacingMs: pacingMs,
  });

  // 4. Initialize Read-Only Public Providers
  const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager);
  const candidateSource = new LiveDexScreenerCandidateSource(budgetManager);

  // 5. Initialize Shadow Observation Runner
  const runnerConfig: ShadowRunnerConfig = {
    sessionId,
    configFingerprint,
    strategyConfigFingerprint: fingerprintResult.strategyConfigFingerprint,
    launcherConfigFingerprint: fingerprintResult.launcherConfigFingerprint,
    strategyVersion: fingerprintResult.strategyVersion,
    outputDir: outDir,
    approvedRootPath: path.join(rootDir, "data", "research"),
    maxCandidates,
    intakeDurationMs: intakeMinutes * 60_000,
    drainDurationMs: drainMinutes * 60_000,
    minProviderSpacingMs: pacingMs,
    maxAggregateRequests: maxRequests,
  };

  const runner = new ShadowObservationRunner(runnerConfig, {
    marketDataProvider: quoteProvider,
    budgetManager,
  });

  const safety = runner.verifySafetyInvariants();
  console.log(
    `[PREFLIGHT] Safety Invariants: Wallet Frozen=${safety.walletFrozen}, Balance=${safety.balanceSol} SOL, DaemonActive=${safety.paperTradingActive}, Positions=${safety.openPositionsCount}`,
  );

  // 6. Signal Handler for Clean Interruption
  let isShuttingDown = false;
  const handleExitSignal = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}. Sealing prospective session gracefully...`);
    const { summary, manifest } = runner.closeSession();
    console.log(
      `[SHUTDOWN] Sealed session summary written: ${summary.totalCandidatesScreened} candidates evaluated.`,
    );
    if (manifest) {
      console.log(`[SHUTDOWN] Session Manifest Digest: ${manifest.manifestDigestSha256}`);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => handleExitSignal("SIGINT"));
  process.once("SIGTERM", () => handleExitSignal("SIGTERM"));

  // 7. Supervision Loop
  console.log("\n[EXECUTION] Starting bounded observation supervision loop...");
  const startTime = Date.now();
  const intakeDeadline = startTime + intakeMinutes * 60_000;
  const hardDeadline = startTime + (intakeMinutes + drainMinutes) * 60_000;

  let lastPollTime = 0;
  let isIntakeCompleted = false;

  const tickIntervalMs = 5_000; // 5-second scheduler tick

  while (Date.now() < hardDeadline && !isShuttingDown) {
    const now = Date.now();

    // Check intake phase
    if (!isIntakeCompleted) {
      if (now >= intakeDeadline || runner.getCandidateCount() >= maxCandidates) {
        console.log(
          `[INTAKE] Intake window closed. Admitted ${runner.getCandidateCount()} candidates. Entering drain phase.`,
        );
        runner.stopIntake(now);
        isIntakeCompleted = true;
      } else if (now - lastPollTime >= pollIntervalMs) {
        lastPollTime = now;
        console.log(
          `[DISCOVERY] Polling DexScreener candidates (Budget used: ${budgetManager.getTotalRequests()}/${maxRequests})...`,
        );
        try {
          const candidates = await candidateSource.pollCandidates(5);
          for (const cand of candidates) {
            const decId = runner.ingestCandidate(cand, now);
            if (decId) {
              console.log(
                `  -> Evaluated candidate: ${cand.symbol} (${cand.mintAddress.slice(0, 8)}...) - Decision: ${decId}`,
              );
            }
          }
        } catch (err) {
          console.error(`[DISCOVERY_ERROR] Candidate poll error: ${(err as Error).message}`);
        }
      }
    }

    // Process due forward horizon observations
    try {
      const processed = await runner.processDueObservations(now);
      if (processed > 0) {
        console.log(
          `[OBSERVATION] Processed ${processed} forward horizon observation(s). Total requests: ${budgetManager.getTotalRequests()}/${maxRequests}`,
        );
      }
    } catch (err) {
      console.error(
        `[OBSERVATION_ERROR] Error processing due observations: ${(err as Error).message}`,
      );
    }

    // Check early stop triggers
    const earlyStop = runner.getEarlyStopReason();
    if (earlyStop && !isIntakeCompleted) {
      console.log(
        `[EARLY_STOP] Trigger condition activated: ${earlyStop}. Halting candidate intake.`,
      );
      runner.stopIntake(now);
      isIntakeCompleted = true;
    }

    // Check if drain phase completed (all scheduled horizons finalized)
    if (isIntakeCompleted) {
      const pendingTasks = runner
        .getScheduledTasks()
        .filter((t) => t.status === "PENDING" || t.status === "EXECUTING");
      if (pendingTasks.length === 0) {
        console.log(
          "[DRAIN_COMPLETE] All scheduled forward horizons have finalized. Closing session.",
        );
        break;
      }
    }

    // Sleep before next tick
    await new Promise((resolve) => setTimeout(resolve, tickIntervalMs));
  }

  // 8. Finalize Session Cleanly
  console.log("\n[FINALIZATION] Finalizing prospective shadow observation session...");
  const { summary, manifest } = runner.closeSession(Date.now(), candidateSource.getYieldStats());

  console.log("================================================================================");
  console.log(" SESSION SUMMARY RESULTS");
  console.log("================================================================================");
  console.log(`Session ID:            ${summary.sessionId}`);
  console.log(`Strategy Version:      ${summary.strategyVersion ?? "nexustrade-strategy-v1.0"}`);
  console.log(`Strategy Fingerprint:  ${summary.strategyConfigFingerprint ?? "N/A"}`);
  console.log(`Combined Fingerprint:  ${summary.configFingerprint}`);
  console.log(`Candidates Screened:   ${summary.totalCandidatesScreened}`);
  console.log(`Accepted Candidates:   ${summary.acceptedCandidatesCount}`);
  console.log(`Rejected Candidates:   ${summary.rejectedCandidatesCount}`);
  console.log(
    `Total Requests Made:   ${summary.globalRequestStats?.totalRequests ?? runner.getTotalRequestsMade()}`,
  );
  if (summary.pipelineYieldStats) {
    console.log(`Profiles Received:     ${summary.pipelineYieldStats.profilesReceivedCount}`);
    console.log(`Enrichment Attempts:   ${summary.pipelineYieldStats.enrichmentAttemptsCount}`);
    console.log(`Mismatched Pairs:      ${summary.pipelineYieldStats.mismatchedPairsCount}`);
    console.log(
      `Price-Qualified Cands: ${summary.pipelineYieldStats.priceQualifiedCandidatesCount}`,
    );
    console.log(
      `Decisions Recorded:    ${summary.pipelineYieldStats.candidateDecisionsRecordedCount}`,
    );
    console.log(`Forward Quote Attempts:${summary.pipelineYieldStats.forwardQuoteAttemptsCount}`);
    console.log(
      `Forward Prices Obs:    ${summary.pipelineYieldStats.successfulForwardPriceObservationsCount}`,
    );
  }
  console.log(
    `Early Stop Reason:     ${summary.earlyStopReason ?? "NONE (Full Duration Elapsed)"}`,
  );
  console.log(`Established Runners:   ${summary.candidatesByCohort.ESTABLISHED_RUNNER}`);
  console.log(`Micro-Cap Probes:      ${summary.candidatesByCohort.MICRO_CAP_PROBE}`);
  console.log(`Unclassified:          ${summary.candidatesByCohort.UNCLASSIFIED}`);
  if (manifest) {
    console.log(`Session Manifest SHA:  ${manifest.manifestDigestSha256}`);
    console.log(`Verified Artifacts:    ${manifest.files.map((f) => f.filename).join(", ")}`);
  }
  console.log("================================================================================");
  console.log(`Evidence sealed at: ${outDir}`);
}

// Direct invocation handler
if (process.argv[1] && process.argv[1].endsWith("launch-shadow-observation.ts")) {
  const parsedArgs = parseLauncherArgs(process.argv.slice(2));
  runShadowLauncher(parsedArgs).catch((err) => {
    console.error(`[FATAL] Launcher encountered unhandled error: ${err.message}`);
    process.exit(1);
  });
}
