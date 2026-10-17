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

export function parseCliArgs(argv: string[]): PilotLiveCollectorConfig {
  const args = argv.slice(2);
  let network: "enabled" | "disabled" = "disabled";
  let rpcUrl = DEFAULT_SOLANA_MAINNET_RPC;
  let pollIntervalSec = 30; // 30s operator default
  let durationSec = 7200; // 2 hours
  let targetCandidates = 100;
  let targetDiagnosticYield = 15;
  let maxMb = 256; // 256 MB accepted RSS limit
  let enableForwardObservations = true;

  // Linux default: ~/nexustrade-pilot-data/sessions/
  // Windows default: .tmp/pilot-data/sessions/
  const defaultDir =
    process.platform === "win32"
      ? path.resolve(".tmp/pilot-data/sessions")
      : path.join(os.homedir(), "nexustrade-pilot-data", "sessions");
  let outputDir = defaultDir;

  for (const arg of args) {
    if (arg === "--network=enabled") {
      network = "enabled";
    } else if (arg === "--network=disabled") {
      network = "disabled";
    } else if (arg.startsWith("--rpc-url=")) {
      rpcUrl = arg.slice("--rpc-url=".length);
    } else if (arg.startsWith("--poll-interval-sec=")) {
      pollIntervalSec = Math.max(5, parseInt(arg.slice("--poll-interval-sec=".length), 10));
    } else if (arg.startsWith("--duration-sec=")) {
      durationSec = Math.max(1, parseInt(arg.slice("--duration-sec=".length), 10));
    } else if (arg.startsWith("--target-candidates=")) {
      targetCandidates = Math.max(1, parseInt(arg.slice("--target-candidates=".length), 10));
    } else if (arg.startsWith("--target-diagnostic-yield=")) {
      targetDiagnosticYield = Math.max(
        1,
        parseInt(arg.slice("--target-diagnostic-yield=".length), 10),
      );
    } else if (arg.startsWith("--max-mb=")) {
      maxMb = Math.max(64, parseInt(arg.slice("--max-mb=".length), 10));
    } else if (arg.startsWith("--output-dir=")) {
      outputDir = path.resolve(arg.slice("--output-dir=".length));
    } else if (arg === "--disable-forward-observations") {
      enableForwardObservations = false;
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

    this.runner = new PilotCollectorRunner({
      sessionId,
      generationId,
      strategyRevision: D23_STRATEGY_REVISION,
      outputRootDir: this.config.outputDir,
      targetCandidates: this.config.targetCandidates,
      targetPools: this.config.targetCandidates,
      maxDiskBytes: this.config.maxMb * 1024 * 1024,
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
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }

    const finalStopReason = this.stopReason ?? "NORMAL_TERMINATION";
    const finalDecisionsCount = this.runner.getStats().candidates;

    // Determine final status
    const targetStatus =
      finalDecisionsCount > 0 || finalStopReason === "DURATION_EXPIRED"
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

// Auto-run if executed directly as entrypoint
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("PilotLiveCollectorCli.ts")) {
  runPilotCollectorCli().then((code) => {
    process.exit(code);
  });
}
