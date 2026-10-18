/**
 * Phase 12.94-D Milestone D.2.4: Pilot Live Collector CLI Entrypoint
 *
 * Implements the minimal, Linux-portable, read-only live collector CLI.
 * Coordinates DexScreener discovery, Solana RPC Raydium AMM v4 verification,
 * forward-observation tracking, and fail-closed safety controls.
 *
 * Safety & Operational Guarantees:
 * - Network defaults to DISABLED: requires explicit '--network=enabled'.
 * - Allowlisted read-only calls only: zero wallet access, zero signing.
 * - Enforces 256 MB RSS memory ceiling and strict stopping semantics.
 * - Linux portable: targets Fedora 44 and Windows isolated environments.
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PilotCollectorRunner } from "./PilotCollectorRunner.js";
import {
  DexScreenerLiveDiscoveryClient,
  type ILiveHttpTransport,
} from "./DexScreenerLiveDiscoveryClient.js";
import {
  SolanaRpcLiveObservationClient,
  type ISolanaRpcTransport,
  DEFAULT_SOLANA_MAINNET_RPC,
} from "./SolanaRpcLiveObservationClient.js";
import { ForwardOutcomeObservationTracker } from "./ForwardOutcomeObservationTracker.js";
import { verifySessionExportManifest } from "./PilotExportManifest.js";
import { D23_STRATEGY_REVISION } from "./PilotSchemaBridge.js";
import type { D23ScreenedCandidate } from "./PilotTypes.js";
import type { DexScreenerPairSummary } from "./DexScreenerResponseAdapter.js";

export class PilotLogger {
  private readonly logFilePath: string | null = null;

  constructor(options?: { logFilePath?: string | null | undefined }) {
    this.logFilePath = options?.logFilePath ? path.resolve(options.logFilePath) : null;
    if (this.logFilePath) {
      try {
        const dir = path.dirname(this.logFilePath);
        fsSync.mkdirSync(dir, { recursive: true });
      } catch {
        // Ignore directory creation failures
      }
    }
  }

  public getLogFilePath(): string | null {
    return this.logFilePath;
  }

  public log(level: "INFO" | "WARN" | "ERROR", tag: string, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] [${tag}] ${message}`;

    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }

    this.appendToFile(line);
  }

  public info(tag: string, message: string): void {
    this.log("INFO", tag, message);
  }

  public warn(tag: string, message: string): void {
    this.log("WARN", tag, message);
  }

  public error(tag: string, message: string): void {
    this.log("ERROR", tag, message);
  }

  private appendToFile(line: string): void {
    if (this.logFilePath) {
      try {
        fsSync.appendFileSync(this.logFilePath, line + "\n", "utf8");
      } catch {
        // Non-fatal write failure
      }
    }
  }
}

export interface PilotLiveCollectorConfig {
  readonly network: "enabled" | "disabled";
  readonly rpcUrl: string;
  readonly pollIntervalSec: number;
  readonly durationSec: number;
  readonly targetCandidates: number;
  readonly targetDiagnosticYield: number;
  readonly maxMb: number;
  readonly maxRssMb?: number | undefined;
  readonly outputDir: string;
  readonly enableForwardObservations: boolean;
  readonly logFilePath?: string | undefined;
  readonly verifyPoolAddress?: string | undefined;
  readonly httpTransport?: ILiveHttpTransport | undefined;
  readonly rpcTransport?: ISolanaRpcTransport | undefined;
  readonly logger?: PilotLogger | undefined;
}

function parsePositiveInt(flagName: string, valueStr: string): number {
  if (!/^\d+$/.test(valueStr)) {
    throw new Error(
      `[INVALID_ARGUMENT] Option '${flagName}' must be a positive integer, got '${valueStr}'`,
    );
  }
  const parsed = parseInt(valueStr, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[INVALID_ARGUMENT] Option '${flagName}' must be greater than 0, got '${parsed}'`,
    );
  }
  return parsed;
}

export function parseCliArgs(argv: string[]): PilotLiveCollectorConfig {
  const args = argv.slice(2);
  let network: "enabled" | "disabled" = "disabled";
  let rpcUrl = DEFAULT_SOLANA_MAINNET_RPC;
  let pollIntervalSec = 30; // 30s operator default
  let durationSec = 7200; // 2 hours
  let targetCandidates = 100;
  let targetDiagnosticYield = 15;
  let maxMb = 256; // 256 MB accepted operational storage limit
  let maxRssMb = 256; // 256 MB accepted RSS memory ceiling
  let enableForwardObservations = true;
  let logFilePath: string | undefined = undefined;
  let verifyPoolAddress: string | undefined = undefined;

  // Linux default: ~/nexustrade-pilot-data/sessions/
  // Windows default: .tmp/pilot-data/sessions/
  const defaultDir =
    process.platform === "win32"
      ? path.resolve(".tmp/pilot-data/sessions")
      : path.join(os.homedir(), "nexustrade-pilot-data", "sessions");
  let outputDir = defaultDir;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`NeXusTrade Pilot Live Collector CLI (Phase 12.94-D.2.4)
Usage: node backend/dist/research/pilot/PilotLiveCollectorCli.js [options]

Required:
  --network=enabled                Explicit authorization required to perform read-only network collection

Options:
  --verify-pool=<address>          Perform independent on-chain Raydium AMM v4 verification and print report
  --rpc-url=<url>                  Solana RPC endpoint URL (default: https://api.mainnet-beta.solana.com)
  --poll-interval-sec=<n>          DexScreener discovery polling interval in seconds (default: 30)
  --duration-sec=<n>               Collection duration limit in seconds (default: 7200)
  --target-candidates=<n>          Safety ceiling of candidates to screen before stopping (default: 100)
  --max-candidates-screened=<n>    Alias for --target-candidates
  --target-yield=<n>               Diagnostic target yield requirement (default: 15)
  --target-verified-candidates=<n> Alias for --target-yield
  --max-mb=<n>                     Maximum disk space ceiling in megabytes (default: 256)
  --max-rss-mb=<n>                 Process resident memory watchdog limit in MB (default: 256)
  --output-dir=<dir>               Local output directory (default: ~/nexustrade-pilot-data/sessions)
  --log-file=<path>                Direct log file path to record operational diagnostics
  --forward-observations=true|false  Enable forward outcome observations at +1m, +5m, +15m (default: true)
  --help, -h                       Display this help text
`);
      process.exit(0);
    } else if (arg === "--network=enabled") {
      network = "enabled";
    } else if (arg === "--network=disabled") {
      network = "disabled";
    } else if (arg.startsWith("--verify-pool=")) {
      const val = arg.slice("--verify-pool=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--verify-pool' requires a non-empty address");
      }
      verifyPoolAddress = val;
    } else if (arg.startsWith("--rpc-url=")) {
      const val = arg.slice("--rpc-url=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--rpc-url' requires a non-empty URL");
      }
      rpcUrl = val;
    } else if (arg.startsWith("--poll-interval-sec=")) {
      pollIntervalSec = parsePositiveInt(
        "--poll-interval-sec",
        arg.slice("--poll-interval-sec=".length),
      );
    } else if (arg.startsWith("--duration-sec=")) {
      durationSec = parsePositiveInt("--duration-sec", arg.slice("--duration-sec=".length));
    } else if (arg.startsWith("--target-candidates=")) {
      targetCandidates = parsePositiveInt(
        "--target-candidates",
        arg.slice("--target-candidates=".length),
      );
    } else if (arg.startsWith("--max-candidates-screened=")) {
      targetCandidates = parsePositiveInt(
        "--max-candidates-screened",
        arg.slice("--max-candidates-screened=".length),
      );
    } else if (arg.startsWith("--target-yield=")) {
      targetDiagnosticYield = parsePositiveInt(
        "--target-yield",
        arg.slice("--target-yield=".length),
      );
    } else if (arg.startsWith("--target-diagnostic-yield=")) {
      targetDiagnosticYield = parsePositiveInt(
        "--target-diagnostic-yield",
        arg.slice("--target-diagnostic-yield=".length),
      );
    } else if (arg.startsWith("--target-verified-candidates=")) {
      targetDiagnosticYield = parsePositiveInt(
        "--target-verified-candidates",
        arg.slice("--target-verified-candidates=".length),
      );
    } else if (arg.startsWith("--max-mb=")) {
      maxMb = parsePositiveInt("--max-mb", arg.slice("--max-mb=".length));
    } else if (arg.startsWith("--max-rss-mb=")) {
      maxRssMb = parsePositiveInt("--max-rss-mb", arg.slice("--max-rss-mb=".length));
    } else if (arg.startsWith("--output-dir=")) {
      const val = arg.slice("--output-dir=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--output-dir' requires a non-empty path");
      }
      outputDir = path.resolve(val);
    } else if (arg.startsWith("--log-file=")) {
      const val = arg.slice("--log-file=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--log-file' requires a non-empty path");
      }
      logFilePath = path.resolve(val);
    } else if (arg === "--forward-observations=true") {
      enableForwardObservations = true;
    } else if (arg === "--forward-observations=false" || arg === "--disable-forward-observations") {
      enableForwardObservations = false;
    } else {
      throw new Error(`[INVALID_ARGUMENT] Unknown CLI option: '${arg}'`);
    }
  }

  return {
    network,
    rpcUrl,
    pollIntervalSec,
    durationSec,
    targetCandidates,
    targetDiagnosticYield,
    maxMb,
    maxRssMb,
    outputDir,
    enableForwardObservations,
    logFilePath,
    verifyPoolAddress,
  };
}

export class PilotLiveCollectorSession {
  private readonly config: PilotLiveCollectorConfig;
  private readonly logger: PilotLogger;
  private runner: PilotCollectorRunner | null = null;
  private discoveryClient: DexScreenerLiveDiscoveryClient | null = null;
  private rpcClient: SolanaRpcLiveObservationClient | null = null;
  private forwardTracker: ForwardOutcomeObservationTracker | null = null;

  private isRunning = false;
  private stopReason: string | null = null;

  constructor(config: PilotLiveCollectorConfig) {
    this.config = config;
    this.logger = config.logger ?? new PilotLogger({ logFilePath: config.logFilePath });
  }

  public getLogger(): PilotLogger {
    return this.logger;
  }

  public async run(): Promise<{
    status: string;
    stopReason: string;
    sessionId: string;
    sessionDir: string;
    totalDecisionsRecorded: number;
    manifestValid: boolean;
    manifestStatus: string;
  }> {
    // 1. Mandatory Network Enablement Check
    if (this.config.network !== "enabled") {
      throw new Error(
        "[NETWORK_DISABLED] Live network collection disabled by default. Pass --network=enabled to authorize network collection.",
      );
    }

    const sessionId = `pilot-sess-${Date.now()}`;
    const generationId = "gen1-pilot";

    // D24F-02: Pass MAX_SAFE_INTEGER so D.2.3 runner never auto-finalizes prematurely.
    // D.2.4 explicitly manages discovery stopping and forward-drain-or-censor before sealing.
    this.runner = new PilotCollectorRunner({
      sessionId,
      generationId,
      strategyRevision: D23_STRATEGY_REVISION,
      outputRootDir: this.config.outputDir,
      targetCandidates: Number.MAX_SAFE_INTEGER,
      targetPools: Number.MAX_SAFE_INTEGER,
      maxDurationSec: Math.max(7200, this.config.durationSec + 1800),
      maxDiskBytes: this.config.maxMb * 1024 * 1024,
      maxRssBytes: (this.config.maxRssMb ?? 256) * 1024 * 1024,
    });

    await this.runner.initialize();
    const sessionDir = this.runner.getSessionDirectory();

    this.logger.info("STARTUP", `Session ${sessionId} initialized in ${sessionDir}`);
    this.logger.info(
      "CONFIG",
      `network=${this.config.network}, pollIntervalSec=${this.config.pollIntervalSec}, durationSec=${this.config.durationSec}, targetCandidates=${this.config.targetCandidates}, targetDiagnosticYield=${this.config.targetDiagnosticYield}, rpcUrl=${this.config.rpcUrl}`,
    );

    this.discoveryClient = new DexScreenerLiveDiscoveryClient({
      pollIntervalMs: this.config.pollIntervalSec * 1000,
      transport: this.config.httpTransport,
      onLog: (msg) => this.logger.info("DEXSCREENER", msg),
    });

    this.rpcClient = new SolanaRpcLiveObservationClient({
      rpcUrl: this.config.rpcUrl,
      transport: this.config.rpcTransport,
      onLog: (msg) => this.logger.info("SOLANA_RPC", msg),
    });

    if (this.config.enableForwardObservations) {
      this.forwardTracker = new ForwardOutcomeObservationTracker({
        sessionDir,
        maxPendingTargets: Math.max(300, this.config.targetCandidates * 3),
      });
      this.logger.info("FORWARD_TRACKER", "Forward outcome tracker initialized (+1m, +5m, +15m)");
    }

    this.isRunning = true;
    const startEpochMs = Date.now();
    const durationMs = this.config.durationSec * 1000;
    const maxRssBytes = (this.config.maxRssMb ?? 256) * 1024 * 1024;
    let lastHeartbeatEpochMs = startEpochMs;

    // Attach graceful interrupt listeners
    const onSignal = () => {
      this.logger.info(
        "SIGNAL",
        "Received interrupt signal (SIGINT/SIGTERM). Initiating graceful shutdown...",
      );
      this.stopReason = "OPERATOR_INTERRUPT";
      this.isRunning = false;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      while (this.isRunning) {
        const now = Date.now();

        // 1. Duration check
        if (now - startEpochMs >= durationMs) {
          this.stopReason = "DURATION_EXPIRED";
          this.logger.info(
            "STOPPING",
            `Session duration expired (${this.config.durationSec}s). Stopping.`,
          );
          break;
        }

        // 2. Candidate target checks
        // A. Desired verified WATCHLIST_RADAR yield reached
        if (this.runner.getStats().radar >= this.config.targetDiagnosticYield) {
          this.stopReason = "TARGET_YIELD_REACHED";
          this.logger.info(
            "STOPPING",
            `Target diagnostic yield reached (${this.runner.getStats().radar} >= ${this.config.targetDiagnosticYield} verified Raydium AMM candidates). Stopping.`,
          );
          break;
        }

        // B. Safety ceiling for total screened candidates reached
        if (this.runner.getStats().candidates >= this.config.targetCandidates) {
          this.stopReason = "MAX_CANDIDATES_SCREENED_REACHED";
          this.logger.info(
            "STOPPING",
            `Max screened candidates safety ceiling reached (${this.runner.getStats().candidates} >= ${this.config.targetCandidates}). Stopping.`,
          );
          break;
        }

        // 3. Memory ceiling check (256 MB RSS)
        const rss = process.memoryUsage().rss;
        if (rss >= maxRssBytes) {
          this.stopReason = "RESOURCE_CEILING_REACHED";
          this.logger.warn(
            "STOPPING",
            `RSS memory ceiling reached (${(rss / 1024 / 1024).toFixed(1)} MB >= ${this.config.maxRssMb ?? 256} MB). Stopping.`,
          );
          break;
        }

        // 4. Discovery Poll (only executed and logged when poll interval or retry is due)
        let discovered: Array<{
          candidate: D23ScreenedCandidate;
          pairSummary: DexScreenerPairSummary | null;
        }> = [];
        if (this.discoveryClient.isPollDue()) {
          this.logger.info(
            "DISCOVERY_POLL",
            `Executing discovery poll... (Mints seen so far: ${this.discoveryClient.getSeenMintsCount()})`,
          );
          discovered = await this.discoveryClient.pollDiscoveredCandidates({
            sessionId,
            generationId,
          });

          if (discovered.length > 0) {
            this.logger.info(
              "DISCOVERY_POLL",
              `Discovered ${discovered.length} candidate record(s) to process.`,
            );
          }
        }

        for (const item of discovered) {
          if (!this.isRunning) break;
          const { candidate, pairSummary } = item;

          if (candidate.passedEligibility && pairSummary?.poolId) {
            // Confirm Raydium AMM on-chain via Solana RPC
            try {
              this.logger.info(
                "RPC_VERIFY",
                `Verifying Raydium pool ${pairSummary.poolId} on-chain for candidate ${candidate.compositeId.mintAddress} (${candidate.symbol})...`,
              );
              const obsResult = await this.rpcClient.observeRaydiumPool({
                poolAddress: pairSummary.poolId,
                targetMint: candidate.compositeId.mintAddress,
                flowMetrics: {
                  volume5mUsd: pairSummary.volume5mUsd,
                  buys5m: pairSummary.buys5m,
                  sells5m: pairSummary.sells5m,
                  netBuyerVolumeUsd: null,
                },
                compositeId: candidate.compositeId,
              });

              if (obsResult.ok && obsResult.observation) {
                const decisionEpochMs = Math.max(Date.now(), obsResult.observation.receiptEpochMs);
                const causalCandidate: D23ScreenedCandidate = {
                  ...candidate,
                  decisionEpochMs,
                };
                await this.runner.recordScreenedCandidate(causalCandidate, obsResult.observation);

                this.logger.info(
                  "CANDIDATE_RECORDED",
                  `[WATCHLIST_RADAR] Mint: ${candidate.compositeId.mintAddress} (${candidate.symbol}) | Pool: ${pairSummary.poolId} | Slot: ${obsResult.observation.onChainSlot} | Total screened: ${this.runner.getStats().candidates}`,
                );

                if (this.forwardTracker) {
                  this.forwardTracker.registerCandidateForForwardObservation(
                    causalCandidate,
                    obsResult.observation,
                  );
                }
              } else {
                const rpcErr = obsResult.error ?? "RPC_OBSERVATION_FAILED";
                this.logger.warn(
                  "RPC_VERIFY_FAILED",
                  `Pool ${pairSummary.poolId} failed verification: ${rpcErr}. Recording as FILTERED_REJECTED.`,
                );
                const decisionEpochMs = Math.max(Date.now(), candidate.receiptEpochMs);
                const rejectedCandidate: D23ScreenedCandidate = {
                  ...candidate,
                  decisionCohort: "FILTERED_REJECTED",
                  passedEligibility: false,
                  decisionEpochMs,
                  filterEvaluations: [
                    ...candidate.filterEvaluations,
                    {
                      filterName: "RAYDIUM_ONCHAIN_RPC_VERIFIED",
                      passed: false,
                      observed: "rpc_failed",
                      threshold: "verified_raydium_amm_v4",
                      rejectionReason: rpcErr,
                    },
                  ],
                  rejectionReasons: [...candidate.rejectionReasons, rpcErr],
                };
                await this.runner.recordScreenedCandidate(rejectedCandidate);
                this.logger.info(
                  "CANDIDATE_RECORDED",
                  `[FILTERED_REJECTED] Mint: ${candidate.compositeId.mintAddress} (${candidate.symbol}) | Rejection: ${rpcErr} | Total screened: ${this.runner.getStats().candidates}`,
                );
              }
            } catch (err) {
              this.logger.warn("PILOT_RECORD_CANDIDATE_ERROR", `${String(err)}`);
            }
          } else {
            // Negative control / Ineligible candidate: record honestly as FILTERED_REJECTED
            try {
              const decisionEpochMs = Math.max(Date.now(), candidate.receiptEpochMs);
              const causalCandidate: D23ScreenedCandidate = {
                ...candidate,
                decisionEpochMs,
              };
              await this.runner.recordScreenedCandidate(causalCandidate);
              const reason = candidate.rejectionReasons[0] ?? "INELIGIBLE";
              this.logger.info(
                "CANDIDATE_RECORDED",
                `[FILTERED_REJECTED] Mint: ${candidate.compositeId.mintAddress} (${candidate.symbol}) | Rejection: ${reason} | Total screened: ${this.runner.getStats().candidates}`,
              );
            } catch (err) {
              this.logger.warn("PILOT_RECORD_CANDIDATE_ERROR", `${String(err)}`);
            }
          }

          // Check if candidate targets reached during candidate loop
          if (this.runner.getStats().radar >= this.config.targetDiagnosticYield) {
            this.stopReason = "TARGET_YIELD_REACHED";
            this.isRunning = false;
            break;
          }
          if (this.runner.getStats().candidates >= this.config.targetCandidates) {
            this.stopReason = "MAX_CANDIDATES_SCREENED_REACHED";
            this.isRunning = false;
            break;
          }
        }

        // 5. Forward Outcome Observations Poll
        if (this.forwardTracker && this.rpcClient) {
          try {
            await this.forwardTracker.pollDueObservations(this.rpcClient, now);
          } catch (fwdErr) {
            this.logger.warn("FORWARD_POLL_ERROR", `${String(fwdErr)}`);
          }
        }

        // 6. Periodic Heartbeat
        const currentStats = this.runner.getStats();
        const elapsedSec = Math.floor((now - startEpochMs) / 1000);
        const rssMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
        const rpcDiag = this.rpcClient.getDiagnostics();
        const fwdPending = this.forwardTracker ? this.forwardTracker.getPendingTargetsCount() : 0;

        if (now - lastHeartbeatEpochMs >= 30_000) {
          lastHeartbeatEpochMs = now;
          this.logger.info(
            "HEARTBEAT",
            `Elapsed: ${elapsedSec}s | Screened: ${currentStats.candidates} (Radar: ${currentStats.radar}, Rejected: ${currentStats.rejected}) | Seen Mints: ${this.discoveryClient.getSeenMintsCount()} | RPC: ${rpcDiag.totalCalls} calls (${rpcDiag.successfulCalls} ok, ${rpcDiag.failedCalls} fail) | Fwd Pending: ${fwdPending} | RSS: ${rssMb} MB`,
          );
        }

        // 7. Sleep small slice (1000ms) with early termination check
        for (let i = 0; i < 10; i++) {
          if (!this.isRunning) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (fatalErr) {
      this.stopReason = "FATAL_ERROR";
      this.logger.error("PILOT_FATAL_ERROR", `${String(fatalErr)}`);
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }

    const finalStopReason = this.stopReason ?? "NORMAL_TERMINATION";
    const finalDecisionsCount = this.runner.getStats().candidates;
    this.logger.info(
      "FINALIZING",
      `Finalizing session. Stop reason: ${finalStopReason}, total candidates screened: ${finalDecisionsCount}`,
    );

    // D24F-02: Forward Outcome Terminal Drainage & Censoring Phase
    // Every registered outcome target and completeness summary must be written before sealing manifest.json
    if (this.forwardTracker) {
      if (
        finalStopReason === "OPERATOR_INTERRUPT" ||
        finalStopReason === "RESOURCE_CEILING_REACHED" ||
        finalStopReason === "FATAL_ERROR"
      ) {
        this.forwardTracker.censorRemainingPendingTargets(
          "CENSORED_TERMINAL_INTERRUPT",
          `Session halted early: ${finalStopReason}`,
        );
      } else {
        // Poll any currently due observations
        if (this.rpcClient) {
          try {
            await this.forwardTracker.pollDueObservations(this.rpcClient, Date.now());
          } catch {
            // Non-critical
          }
        }
        // Account for any remaining pending targets whose scheduled interval exceeds session lifetime
        const censorReason =
          finalStopReason === "DURATION_EXPIRED"
            ? "SESSION_DURATION_EXPIRED_BEFORE_INTERVAL"
            : "TARGET_REACHED_BEFORE_FORWARD_WINDOW";
        this.forwardTracker.censorRemainingPendingTargets("WINDOW_TRUNCATED", censorReason);
      }

      this.forwardTracker.writeForwardSummary();
      this.logger.info("FORWARD_SUMMARY", "Forward outcomes summary written to disk.");
    }

    // Determine truthful final status
    const targetStatus =
      (finalStopReason === "TARGET_REACHED" ||
        finalStopReason === "TARGET_YIELD_REACHED" ||
        finalStopReason === "MAX_CANDIDATES_SCREENED_REACHED" ||
        finalStopReason === "DURATION_EXPIRED" ||
        finalStopReason === "NORMAL_TERMINATION") &&
      finalDecisionsCount > 0
        ? "FINALIZED"
        : "INTERRUPTED";

    await this.runner.finalize(targetStatus);

    let manifestValid = false;
    let manifestStatus = "NOT_APPLICABLE_INTERRUPTED";

    if (targetStatus === "FINALIZED") {
      const manifestResult = await verifySessionExportManifest(sessionDir);
      manifestValid = manifestResult.valid;
      manifestStatus = manifestResult.valid ? "VALID" : "INVALID";
      this.logger.info(
        "SHUTDOWN",
        `Export manifest verified: ${manifestStatus} (valid=${manifestValid})`,
      );
    } else {
      this.logger.info(
        "SHUTDOWN",
        `Session finalized as ${targetStatus}. Export manifest skipped intentionally for incomplete session.`,
      );
    }

    return {
      status: targetStatus,
      stopReason: finalStopReason,
      sessionId,
      sessionDir,
      totalDecisionsRecorded: finalDecisionsCount,
      manifestValid,
      manifestStatus,
    };
  }
}

export { PilotLiveCollectorSession as LiveCollectorRunner };

/**
 * CLI Execution Entrypoint
 */
export async function runPilotCollectorCli(
  argv: string[] = process.argv,
  options?: {
    httpTransport?: ILiveHttpTransport | undefined;
    rpcTransport?: ISolanaRpcTransport | undefined;
    logger?: PilotLogger | undefined;
  },
): Promise<number> {
  let config: PilotLiveCollectorConfig;
  try {
    config = parseCliArgs(argv);
    if (options?.httpTransport || options?.rpcTransport || options?.logger) {
      config = {
        ...config,
        ...(options.httpTransport ? { httpTransport: options.httpTransport } : {}),
        ...(options.rpcTransport ? { rpcTransport: options.rpcTransport } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      };
    }
  } catch (err) {
    console.error(`[CONFIG_ERROR] Failed to parse CLI arguments: ${err}`);
    return 1;
  }

  if (config.network !== "enabled") {
    console.error(
      "[NETWORK_DISABLED] Live network collection disabled by default. Pass --network=enabled to authorize network collection.",
    );
    return 1;
  }

  // Independent On-Chain Raydium Pool Verification Diagnostic Mode (Task 2)
  if (config.verifyPoolAddress) {
    const logger = config.logger ?? new PilotLogger({ logFilePath: config.logFilePath });
    logger.info(
      "VERIFY_POOL_START",
      `Initiating independent on-chain verification for pool ${config.verifyPoolAddress}...`,
    );
    const rpcClient = new SolanaRpcLiveObservationClient({
      rpcUrl: config.rpcUrl,
      transport: config.rpcTransport,
      onLog: (msg) => logger.info("SOLANA_RPC", msg),
    });

    const report = await rpcClient.verifyPoolAccount(config.verifyPoolAddress);
    console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

    if (report.verified) {
      logger.info(
        "VERIFY_POOL_SUCCESS",
        `Pool ${config.verifyPoolAddress} verified as canonical Raydium AMM v4.`,
      );
      return 0;
    } else {
      logger.warn(
        "VERIFY_POOL_FAILED",
        `Pool ${config.verifyPoolAddress} verification failed: ${report.verificationStatus} (${report.error ?? "Verification error"})`,
      );
      return 1;
    }
  }

  try {
    const session = new PilotLiveCollectorSession(config);
    const result = await session.run();

    console.log(JSON.stringify(result, null, 2));

    if (result.totalDecisionsRecorded < config.targetDiagnosticYield) {
      console.warn(
        `[DIAGNOSTIC_WARNING] Session yielded ${result.totalDecisionsRecorded} candidates (diagnostic target was ${config.targetDiagnosticYield}). Feed may have low promotional mint velocity.`,
      );
    }

    if (result.stopReason === "FATAL_ERROR") {
      return 1;
    }

    if (result.status === "INTERRUPTED") {
      // Clean operator termination or early stop of incomplete session is not a manifest error
      return 0;
    }

    return result.manifestValid ? 0 : 2;
  } catch (err: unknown) {
    console.error(`[EXECUTION_ERROR] Pilot collector encountered fatal error: ${err}`);
    return 1;
  }
}

// Auto-run if executed directly as entrypoint in either TypeScript or compiled JavaScript (D24F-01)
const scriptPath = process.argv[1];
const isEntrypoint =
  typeof scriptPath === "string" &&
  (path.basename(scriptPath).replace(/\.[jt]sx?$/, "") === "PilotLiveCollectorCli" ||
    path.resolve(scriptPath) === path.resolve(fileURLToPath(import.meta.url)));

if (isEntrypoint) {
  runPilotCollectorCli().then((code) => {
    process.exit(code);
  });
}
