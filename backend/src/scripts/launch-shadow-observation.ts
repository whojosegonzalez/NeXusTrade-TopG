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
  pacingMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  dryRun?: boolean | undefined;
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
    } else if (arg === "--pacingMs" && argv[i + 1]) {
      args.pacingMs = Number(argv[++i]);
    } else if (arg === "--pollIntervalMs" && argv[i + 1]) {
      args.pollIntervalMs = Number(argv[++i]);
    } else if (arg === "--dryRun") {
      args.dryRun = true;
    }
  }
  return args;
}

export async function runShadowLauncher(cliArgs: ShadowLauncherArgs = {}): Promise<void> {
  const sessionId =
    cliArgs.sessionId || `shadow-live-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const outDir = cliArgs.outDir || path.join(rootDir, "data", "research", "prospective", sessionId);

  const intakeMinutes = cliArgs.intakeMinutes ?? 60;
  const drainMinutes = cliArgs.drainMinutes ?? 60;
  const maxCandidates = cliArgs.maxCandidates ?? 25;
  const maxRequests = cliArgs.maxRequests ?? 120;
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
  console.log(`Provider Pacing:     ${pacingMs} ms`);
  console.log(`Virtual Wallet:      7.9259 SOL (Strictly Frozen)`);
  console.log("================================================================================");

  // Mandatory Preflight Isolation Checks
  console.log("\n[PREFLIGHT] Verifying safety and isolation invariants...");

  // 1. Directory Collision Guard
  if (fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir);
    if (
      existing.includes("decision-observations.jsonl") ||
      existing.includes("session-manifest.json")
    ) {
      throw new Error(
        `[PREFLIGHT_FAIL] Output directory ${outDir} already contains session evidence. Aborting to prevent overwrite.`,
      );
    }
  } else {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 2. Compute Config Fingerprint
  const configFingerprint = `sha256:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        sessionId,
        intakeMinutes,
        drainMinutes,
        maxCandidates,
        maxRequests,
        pacingMs,
        walletBalance: "7.9259 SOL",
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;

  console.log(`[PREFLIGHT] Config Fingerprint: ${configFingerprint}`);

  if (cliArgs.dryRun) {
    console.log("[PREFLIGHT] Dry-run requested. Exiting cleanly before any network activity.");
    return;
  }

  // 3. Initialize Shared Global Resource Controller
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: maxRequests,
    minProviderSpacingMs: pacingMs,
  });

  // 4. Initialize Read-Only Public Providers
  const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager);
  const candidateSource = new LiveDexScreenerCandidateSource(budgetManager);

  // 5. Initialize Shadow Observation Runner
  const runnerConfig: ShadowRunnerConfig = {
    sessionId,
    configFingerprint,
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
  const { summary, manifest } = runner.closeSession(Date.now());

  console.log("================================================================================");
  console.log(" SESSION SUMMARY RESULTS");
  console.log("================================================================================");
  console.log(`Session ID:            ${summary.sessionId}`);
  console.log(`Candidates Screened:   ${summary.totalCandidatesScreened}`);
  console.log(`Accepted Candidates:   ${summary.acceptedCandidatesCount}`);
  console.log(`Rejected Candidates:   ${summary.rejectedCandidatesCount}`);
  console.log(
    `Total Requests Made:   ${summary.globalRequestStats?.totalRequests ?? runner.getTotalRequestsMade()}`,
  );
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
