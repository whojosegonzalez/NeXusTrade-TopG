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
  readonly httpTransport?: ILiveHttpTransport | undefined;
  readonly rpcTransport?: ISolanaRpcTransport | undefined;
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
  --rpc-url=<url>                  Solana RPC endpoint URL (default: https://api.mainnet-beta.solana.com)
  --poll-interval-sec=<n>          DexScreener discovery polling interval in seconds (default: 30)
  --duration-sec=<n>               Collection duration limit in seconds (default: 7200)
  --target-candidates=<n>          Target number of candidates to screen before stopping (default: 100)
  --target-yield=<n>               Diagnostic target yield requirement (default: 15)
  --max-mb=<n>                     Maximum disk space ceiling in megabytes (default: 20)
  --max-rss-mb=<n>                 Process resident memory watchdog limit in MB (default: 256)
  --output-dir=<dir>               Local output directory (default: ~/nexustrade-pilot-data/sessions)
  --forward-observations=true|false  Enable forward outcome observations at +1m, +5m, +15m (default: true)
  --help, -h                       Display this help text
`);
      process.exit(0);
    } else if (arg === "--network=enabled") {
      network = "enabled";
    } else if (arg === "--network=disabled") {
      network = "disabled";
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
  };
}

export class PilotLiveCollectorSession {
  private readonly config: PilotLiveCollectorConfig;
  private runner: PilotCollectorRunner | null = null;
  private discoveryClient: DexScreenerLiveDiscoveryClient | null = null;
  private rpcClient: SolanaRpcLiveObservationClient | null = null;
  private forwardTracker: ForwardOutcomeObservationTracker | null = null;

  private isRunning = false;
  private stopReason: string | null = null;

  constructor(config: PilotLiveCollectorConfig) {
    this.config = config;
  }

  public async run(): Promise<{
    status: string;
    stopReason: string;
    sessionId: string;
    sessionDir: string;
    totalDecisionsRecorded: number;
    manifestValid: boolean;
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

    this.discoveryClient = new DexScreenerLiveDiscoveryClient({
      pollIntervalMs: this.config.pollIntervalSec * 1000,
      transport: this.config.httpTransport,
    });

    this.rpcClient = new SolanaRpcLiveObservationClient({
      rpcUrl: this.config.rpcUrl,
      transport: this.config.rpcTransport,
    });

    if (this.config.enableForwardObservations) {
      this.forwardTracker = new ForwardOutcomeObservationTracker({
        sessionDir,
        maxPendingTargets: Math.max(300, this.config.targetCandidates * 3),
      });
    }

    this.isRunning = true;
    const startEpochMs = Date.now();
    const durationMs = this.config.durationSec * 1000;
    const maxRssBytes = (this.config.maxRssMb ?? 256) * 1024 * 1024;

    // Attach graceful interrupt listeners
    const onSignal = () => {
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
          break;
        }

        // 2. Candidate target check
        if (this.runner.getStats().candidates >= this.config.targetCandidates) {
          this.stopReason = "TARGET_REACHED";
          break;
        }

        // 3. Memory ceiling check (256 MB RSS)
        const rss = process.memoryUsage().rss;
        if (rss >= maxRssBytes) {
          this.stopReason = "RESOURCE_CEILING_REACHED";
          break;
        }

        // 4. Discovery Poll
        const discovered = await this.discoveryClient.pollDiscoveredCandidates({
          sessionId,
          generationId,
        });

        for (const item of discovered) {
          if (!this.isRunning) break;
          const { candidate, pairSummary } = item;

          if (candidate.passedEligibility && pairSummary?.poolId) {
            // Confirm Raydium AMM on-chain via Solana RPC
            try {
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

                if (this.forwardTracker) {
                  this.forwardTracker.registerCandidateForForwardObservation(
                    causalCandidate,
                    obsResult.observation,
                  );
                }
              } else if (!obsResult.ok) {
                console.warn(`[PILOT_RPC_OBSERVE_FAILED] ${obsResult.error ?? "unknown error"}`);
              }
            } catch (err) {
              console.warn(`[PILOT_RECORD_CANDIDATE_ERROR] ${String(err)}`);
            }
          }

          // Check if candidate target reached during candidate loop
          if (this.runner.getStats().candidates >= this.config.targetCandidates) {
            this.stopReason = "TARGET_REACHED";
            this.isRunning = false;
            break;
          }
        }

        // 5. Forward Outcome Observations Poll
        if (this.forwardTracker && this.rpcClient) {
          try {
            await this.forwardTracker.pollDueObservations(this.rpcClient, now);
          } catch {
            // Non-critical forward poll error
          }
        }

        // 6. Sleep small slice (1000ms) with early termination check
        for (let i = 0; i < 10; i++) {
          if (!this.isRunning) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } catch (fatalErr) {
      this.stopReason = "FATAL_ERROR";
      console.error(`[PILOT_FATAL_ERROR] ${String(fatalErr)}`);
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }

    const finalStopReason = this.stopReason ?? "NORMAL_TERMINATION";
    const finalDecisionsCount = this.runner.getStats().candidates;

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
    }

    // Determine truthful final status
    const targetStatus =
      (finalStopReason === "TARGET_REACHED" ||
        finalStopReason === "DURATION_EXPIRED" ||
        finalStopReason === "NORMAL_TERMINATION") &&
      finalDecisionsCount > 0
        ? "FINALIZED"
        : "INTERRUPTED";

    await this.runner.finalize(targetStatus);

    const manifestResult = await verifySessionExportManifest(sessionDir);

    return {
      status: targetStatus,
      stopReason: finalStopReason,
      sessionId,
      sessionDir,
      totalDecisionsRecorded: finalDecisionsCount,
      manifestValid: manifestResult.valid,
    };
  }
}

export { PilotLiveCollectorSession as LiveCollectorRunner };

/**
 * CLI Execution Entrypoint
 */
export async function runPilotCollectorCli(argv: string[] = process.argv): Promise<number> {
  let config: PilotLiveCollectorConfig;
  try {
    config = parseCliArgs(argv);
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

  try {
    const session = new PilotLiveCollectorSession(config);
    const result = await session.run();

    console.log(JSON.stringify(result, null, 2));

    if (result.totalDecisionsRecorded < config.targetDiagnosticYield) {
      console.warn(
        `[DIAGNOSTIC_WARNING] Session yielded ${result.totalDecisionsRecorded} candidates (diagnostic target was ${config.targetDiagnosticYield}). Feed may have low promotional mint velocity.`,
      );
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
