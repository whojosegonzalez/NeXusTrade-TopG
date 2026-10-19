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
import { RaydiumLiveDiscoveryClient } from "./RaydiumLiveDiscoveryClient.js";
import {
  SolanaRpcLiveObservationClient,
  type ISolanaRpcTransport,
  DEFAULT_SOLANA_MAINNET_RPC,
} from "./SolanaRpcLiveObservationClient.js";
import { ForwardOutcomeObservationTracker } from "./ForwardOutcomeObservationTracker.js";
import { verifySessionExportManifest } from "./PilotExportManifest.js";
import { D23_STRATEGY_REVISION } from "./PilotSchemaBridge.js";
import type { D23ScreenedCandidate } from "./PilotTypes.js";
import type { DiscoveryFunnelMetrics } from "../../telemetry/TelemetryTypes.js";

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

export type RpcVerificationFailureType = "TRANSIENT_PROVIDER_ERROR" | "CONFIRMED_INELIGIBILITY";

/**
 * Classifies an RPC observation error as confirmed on-chain protocol ineligibility
 * vs transient provider availability error (D25-F1).
 */
export function classifyRpcVerificationError(errorMsg?: string | null): {
  type: RpcVerificationFailureType;
  reasonCode: string;
} {
  if (!errorMsg) {
    return { type: "TRANSIENT_PROVIDER_ERROR", reasonCode: "RPC_OBSERVATION_FAILED" };
  }
  const msgLower = errorMsg.toLowerCase();

  // 1. Confirmed On-Chain Protocol Ineligibility
  if (msgLower.includes("unauthorized_pool_owner") || msgLower.includes("unauthorized")) {
    return { type: "CONFIRMED_INELIGIBILITY", reasonCode: "UNAUTHORIZED_POOL_OWNER" };
  }
  if (msgLower.includes("null value") || msgLower.includes("not found on-chain")) {
    return { type: "CONFIRMED_INELIGIBILITY", reasonCode: "NULL_ACCOUNT" };
  }
  if (
    msgLower.includes("raydium parse error") ||
    msgLower.includes("failed to extract base64") ||
    msgLower.includes("invalid solana base58")
  ) {
    return { type: "CONFIRMED_INELIGIBILITY", reasonCode: "MALFORMED_POOL_DATA" };
  }
  if (
    msgLower.includes("vault account") ||
    msgLower.includes("vault token mint") ||
    msgLower.includes("failed to decode pool vault")
  ) {
    return { type: "CONFIRMED_INELIGIBILITY", reasonCode: "VAULT_VERIFICATION_FAILED" };
  }

  // 2. Transient Provider Errors
  if (
    msgLower.includes("429") ||
    msgLower.includes("throttled") ||
    msgLower.includes("rate_budget_exceeded") ||
    msgLower.includes("rate-limited")
  ) {
    return { type: "TRANSIENT_PROVIDER_ERROR", reasonCode: "RATE_LIMITED_429" };
  }
  if (
    msgLower.includes("timeout") ||
    msgLower.includes("timed out") ||
    msgLower.includes("aborterror")
  ) {
    return { type: "TRANSIENT_PROVIDER_ERROR", reasonCode: "RPC_TIMEOUT" };
  }

  // General network / transport / 5xx RPC provider error
  return { type: "TRANSIENT_PROVIDER_ERROR", reasonCode: "RPC_UNAVAILABLE" };
}

export interface DeferredVerificationCandidate {
  readonly candidate: D23ScreenedCandidate;
  readonly poolId: string;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  retryCount: number;
  lastAttemptEpochMs: number;
  lastError: string;
}

export const MAX_RPC_VERIFICATION_RETRIES = 3;
export const RPC_RETRY_BACKOFF_MS = 2000;

export interface PilotLiveCollectorConfig {
  readonly network: "enabled" | "disabled";
  readonly rpcUrl: string;
  readonly pollIntervalSec: number;
  readonly durationSec: number;
  readonly targetCandidates: number;
  readonly maxCandidatesScreened?: number | undefined;
  readonly targetDiagnosticYield: number;
  readonly maxMb: number;
  readonly maxRssMb?: number | undefined;
  readonly outputDir: string;
  readonly enableForwardObservations: boolean;
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
  readonly logFilePath?: string | undefined;
  readonly verifyPoolAddress?: string | undefined;
  readonly httpTransport?: ILiveHttpTransport | undefined;
  readonly rpcTransport?: ISolanaRpcTransport | undefined;
  readonly logger?: PilotLogger | undefined;
}

function parseNonNegativeInt(flagName: string, valueStr: string): number {
  if (!/^\d+$/.test(valueStr)) {
    throw new Error(
      `[INVALID_ARGUMENT] Option '${flagName}' must be a non-negative integer, got '${valueStr}'`,
    );
  }
  const parsed = parseInt(valueStr, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[INVALID_ARGUMENT] Option '${flagName}' must be greater than or equal to 0, got '${parsed}'`,
    );
  }
  return parsed;
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
  let targetCandidates = 15;
  let targetDiagnosticYield = 15;
  let maxCandidatesScreened = 500; // Hard safety stop ceiling for screened candidates (D25-F2)
  let explicitTargetCandidates = false;
  let explicitTargetYield = false;
  let explicitMaxCandidatesScreened = false;
  let maxMb = 256; // 256 MB accepted operational storage limit
  let maxRssMb = 256; // 256 MB accepted RSS memory ceiling
  let enableForwardObservations = true;
  let discoverySource: "dexscreener" | "raydium" = "dexscreener";
  let maxPoolAgeSec = 0;
  let minRequestIntervalMs = 2000;
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
      console.log(`NeXusTrade Pilot Live Collector CLI (Phase 12.94-D.2.4 / D.2.5)
Usage: node backend/dist/research/pilot/PilotLiveCollectorCli.js [options]

Required:
  --network=enabled                Explicit authorization required to perform read-only network collection

Options:
  --verify-pool=<address>          Perform independent on-chain Raydium AMM v4 verification and print report
  --rpc-url=<url>                  Solana RPC endpoint URL (default: https://api.mainnet-beta.solana.com)
  --discovery-source=dexscreener|raydium Discovery source adapter (default: dexscreener)
  --max-pool-age-sec=<n>           Max pool age in seconds (0 = filter-disabled mode, default: 0)
  --min-request-interval-ms=<n>    Minimum inter-request spacing in ms (default: 2000, 30 req/min budget)
  --poll-interval-sec=<n>          Discovery polling interval in seconds (default: 30)
  --duration-sec=<n>               Collection duration limit in seconds (default: 7200)
  --target-yield=<n>               Diagnostic target yield requirement of eligible candidates (default: 15)
  --target-candidates=<n>          Alias for --target-yield
  --target-verified-candidates=<n> Alias for --target-yield
  --max-candidates-screened=<n>    Safety ceiling of total candidates screened before stopping (default: 500)
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
    } else if (arg.startsWith("--discovery-source=")) {
      const val = arg.slice("--discovery-source=".length).trim().toLowerCase();
      if (val !== "dexscreener" && val !== "raydium") {
        throw new Error(
          `[INVALID_ARGUMENT] Option '--discovery-source' must be 'dexscreener' or 'raydium', got '${val}'`,
        );
      }
      discoverySource = val;
    } else if (arg.startsWith("--max-pool-age-sec=")) {
      maxPoolAgeSec = parseNonNegativeInt(
        "--max-pool-age-sec",
        arg.slice("--max-pool-age-sec=".length),
      );
    } else if (arg.startsWith("--min-request-interval-ms=")) {
      minRequestIntervalMs = parseNonNegativeInt(
        "--min-request-interval-ms",
        arg.slice("--min-request-interval-ms=".length),
      );
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
      explicitTargetCandidates = true;
      targetCandidates = parseNonNegativeInt(
        "--target-candidates",
        arg.slice("--target-candidates=".length),
      );
    } else if (arg.startsWith("--max-candidates-screened=")) {
      explicitMaxCandidatesScreened = true;
      maxCandidatesScreened = parsePositiveInt(
        "--max-candidates-screened",
        arg.slice("--max-candidates-screened=".length),
      );
    } else if (arg.startsWith("--target-yield=")) {
      explicitTargetYield = true;
      targetDiagnosticYield = parseNonNegativeInt(
        "--target-yield",
        arg.slice("--target-yield=".length),
      );
    } else if (arg.startsWith("--target-diagnostic-yield=")) {
      explicitTargetYield = true;
      targetDiagnosticYield = parseNonNegativeInt(
        "--target-diagnostic-yield",
        arg.slice("--target-diagnostic-yield=".length),
      );
    } else if (arg.startsWith("--target-verified-candidates=")) {
      explicitTargetYield = true;
      targetDiagnosticYield = parseNonNegativeInt(
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

  // D26-F5: Reconcile legacy CLI semantics safely across DexScreener and Raydium discovery sources
  if (discoverySource === "dexscreener") {
    // Legacy D.2.4 DexScreener behavior: targetCandidates specifies the total candidates to screen
    if (explicitTargetCandidates && !explicitMaxCandidatesScreened) {
      maxCandidatesScreened = targetCandidates;
    }
    if (explicitTargetCandidates && !explicitTargetYield) {
      targetDiagnosticYield = targetCandidates;
    }
    if (!explicitMaxCandidatesScreened && !explicitTargetCandidates) {
      maxCandidatesScreened = 100;
    }
  } else {
    // Raydium discovery behavior (D.2.5 / D.2.6):
    // If operator provided --target-candidates but not --target-yield, accept as alias for target yield
    if (explicitTargetCandidates && !explicitTargetYield) {
      targetDiagnosticYield = targetCandidates;
    }
    // If operator specified target yield but not maxCandidatesScreened, provide standard safety ceiling
    if (!explicitMaxCandidatesScreened) {
      maxCandidatesScreened = Math.max(500, targetDiagnosticYield * 10);
    }
  }

  return {
    network,
    rpcUrl,
    pollIntervalSec,
    durationSec,
    targetCandidates,
    maxCandidatesScreened,
    targetDiagnosticYield,
    maxMb,
    maxRssMb,
    outputDir,
    enableForwardObservations,
    discoverySource,
    maxPoolAgeSec,
    minRequestIntervalMs,
    logFilePath,
    verifyPoolAddress,
  };
}

export class PilotLiveCollectorSession {
  private readonly config: PilotLiveCollectorConfig;
  private readonly logger: PilotLogger;
  private runner: PilotCollectorRunner | null = null;
  private discoveryClient: DexScreenerLiveDiscoveryClient | null = null;
  private raydiumClient: RaydiumLiveDiscoveryClient | null = null;
  private rpcClient: SolanaRpcLiveObservationClient | null = null;
  private forwardTracker: ForwardOutcomeObservationTracker | null = null;

  private isRunning = false;
  private stopReason: string | null = null;
  private readonly deferredVerificationQueue: DeferredVerificationCandidate[] = [];

  // Funnel accounting counters (D26-F3)
  private verificationAttempts = 0;
  private verifiedAmmV4Pools = 0;
  private confirmedOnChainIneligible = 0;
  private rpcProviderUnavailable = 0;
  private rpcRetriesExhausted = 0;
  private unreachedCandidatesDueToStopping = 0;

  constructor(config: PilotLiveCollectorConfig) {
    this.config = config;
    this.logger = config.logger ?? new PilotLogger({ logFilePath: config.logFilePath });
  }

  public getLogger(): PilotLogger {
    return this.logger;
  }

  public getDeferredVerificationQueueCount(): number {
    return this.deferredVerificationQueue.length;
  }

  private async processDeferredVerifications(now: number): Promise<void> {
    if (!this.rpcClient || !this.runner || this.deferredVerificationQueue.length === 0) {
      return;
    }

    const remainingQueue: DeferredVerificationCandidate[] = [];

    for (const item of this.deferredVerificationQueue) {
      if (!this.isRunning) {
        remainingQueue.push(item);
        continue;
      }

      if (now - item.lastAttemptEpochMs < RPC_RETRY_BACKOFF_MS) {
        remainingQueue.push(item);
        continue;
      }

      try {
        this.logger.info(
          "RPC_VERIFY_RETRY",
          `Retrying on-chain verification for candidate ${item.candidate.compositeId.mintAddress} (${item.candidate.symbol}) / pool ${item.poolId} (attempt ${item.retryCount + 1}/${MAX_RPC_VERIFICATION_RETRIES})...`,
        );

        this.verificationAttempts++;
        const obsResult = await this.rpcClient.observeRaydiumPool({
          poolAddress: item.poolId,
          targetMint: item.candidate.compositeId.mintAddress,
          flowMetrics: {
            volume5mUsd: item.volume5mUsd,
            buys5m: item.buys5m,
            sells5m: item.sells5m,
            netBuyerVolumeUsd: null,
          },
          compositeId: item.candidate.compositeId,
        });

        if (obsResult.ok && obsResult.observation) {
          this.verifiedAmmV4Pools++;
          const decisionEpochMs = Math.max(Date.now(), obsResult.observation.receiptEpochMs);
          const causalCandidate: D23ScreenedCandidate = {
            ...item.candidate,
            decisionEpochMs,
          };
          await this.runner.recordScreenedCandidate(causalCandidate, obsResult.observation);

          this.logger.info(
            "RPC_VERIFY_RECOVERED",
            `[WATCHLIST_RADAR] Mint: ${item.candidate.compositeId.mintAddress} (${item.candidate.symbol}) | Pool: ${item.poolId} | Slot: ${obsResult.observation.onChainSlot} | Verified on retry ${item.retryCount + 1}`,
          );

          if (this.forwardTracker) {
            this.forwardTracker.registerCandidateForForwardObservation(
              causalCandidate,
              obsResult.observation,
            );
          }
        } else {
          const rawErr = obsResult.error ?? "RPC_OBSERVATION_FAILED";
          const classification = classifyRpcVerificationError(rawErr);

          if (classification.type === "CONFIRMED_INELIGIBILITY") {
            this.confirmedOnChainIneligible++;
            const rpcErr = classification.reasonCode;
            this.logger.warn(
              "RPC_VERIFY_INELIGIBLE",
              `Pool ${item.poolId} confirmed on-chain ineligibility on retry [${rpcErr}]: ${rawErr}. Recording as FILTERED_REJECTED.`,
            );
            const decisionEpochMs = Math.max(Date.now(), item.candidate.receiptEpochMs);
            const rejectedCandidate: D23ScreenedCandidate = {
              ...item.candidate,
              decisionCohort: "FILTERED_REJECTED",
              passedEligibility: false,
              decisionEpochMs,
              filterEvaluations: [
                ...item.candidate.filterEvaluations,
                {
                  filterName: "RAYDIUM_ONCHAIN_RPC_VERIFIED",
                  passed: false,
                  observed: "confirmed_ineligible",
                  threshold: "verified_raydium_amm_v4",
                  rejectionReason: rpcErr,
                },
              ],
              rejectionReasons: [...item.candidate.rejectionReasons, rpcErr],
            };
            await this.runner.recordScreenedCandidate(rejectedCandidate);
            this.logger.info(
              "CANDIDATE_RECORDED",
              `[FILTERED_REJECTED] Mint: ${item.candidate.compositeId.mintAddress} (${item.candidate.symbol}) | Rejection: ${rpcErr} | Total screened: ${this.runner.getStats().candidates}`,
            );
          } else {
            this.rpcProviderUnavailable++;
            item.retryCount += 1;
            item.lastAttemptEpochMs = Date.now();
            item.lastError = `${classification.reasonCode}:${rawErr}`;

            if (item.retryCount >= MAX_RPC_VERIFICATION_RETRIES) {
              this.rpcRetriesExhausted++;
              const reason = "RPC_VERIFICATION_EXHAUSTED";
              this.logger.warn(
                "RPC_VERIFY_EXHAUSTED",
                `Pool ${item.poolId} verification exhausted after ${item.retryCount} retries. Provider error provenance: ${item.lastError}`,
              );
              const decisionEpochMs = Math.max(Date.now(), item.candidate.receiptEpochMs);
              const rejectedCandidate: D23ScreenedCandidate = {
                ...item.candidate,
                decisionCohort: "FILTERED_REJECTED",
                passedEligibility: false,
                decisionEpochMs,
                filterEvaluations: [
                  ...item.candidate.filterEvaluations,
                  {
                    filterName: "RAYDIUM_ONCHAIN_RPC_VERIFIED",
                    passed: false,
                    observed: "rpc_unavailable",
                    threshold: "verified_raydium_amm_v4",
                    rejectionReason: `${reason}:${item.lastError}`,
                  },
                ],
                rejectionReasons: [...item.candidate.rejectionReasons, reason],
              };
              await this.runner.recordScreenedCandidate(rejectedCandidate);
              this.logger.info(
                "CANDIDATE_RECORDED",
                `[FILTERED_REJECTED] Mint: ${item.candidate.compositeId.mintAddress} (${item.candidate.symbol}) | Rejection: ${reason} | Total screened: ${this.runner.getStats().candidates}`,
              );
            } else {
              remainingQueue.push(item);
            }
          }
        }
      } catch (retryErr) {
        this.logger.warn("RPC_RETRY_ERROR", `${String(retryErr)}`);
        remainingQueue.push(item);
      }
    }

    this.deferredVerificationQueue.length = 0;
    this.deferredVerificationQueue.push(...remainingQueue);
  }

  private async drainRemainingDeferredVerifications(reasonPrefix: string): Promise<void> {
    if (!this.runner || this.deferredVerificationQueue.length === 0) return;

    this.logger.info(
      "DRAIN_DEFERRED_VERIFICATIONS",
      `Draining ${this.deferredVerificationQueue.length} deferred verification candidate(s) before shutdown...`,
    );

    for (const item of this.deferredVerificationQueue) {
      try {
        this.rpcRetriesExhausted++;
        const reason = "RPC_VERIFICATION_EXHAUSTED";
        const decisionEpochMs = Math.max(Date.now(), item.candidate.receiptEpochMs);
        const rejectedCandidate: D23ScreenedCandidate = {
          ...item.candidate,
          decisionCohort: "FILTERED_REJECTED",
          passedEligibility: false,
          decisionEpochMs,
          filterEvaluations: [
            ...item.candidate.filterEvaluations,
            {
              filterName: "RAYDIUM_ONCHAIN_RPC_VERIFIED",
              passed: false,
              observed: "rpc_unavailable",
              threshold: "verified_raydium_amm_v4",
              rejectionReason: `${reason}:${reasonPrefix}:${item.lastError}`,
            },
          ],
          rejectionReasons: [...item.candidate.rejectionReasons, reason],
        };
        await this.runner.recordScreenedCandidate(rejectedCandidate);
      } catch (drainErr) {
        this.logger.warn("DRAIN_DEFERRED_ERROR", `${String(drainErr)}`);
      }
    }

    this.deferredVerificationQueue.length = 0;
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
      discoverySource: this.config.discoverySource ?? "dexscreener",
      maxPoolAgeSec: this.config.maxPoolAgeSec ?? 0,
      minRequestIntervalMs: this.config.minRequestIntervalMs ?? 2000,
    });

    await this.runner.initialize();
    const sessionDir = this.runner.getSessionDirectory();

    const discoverySource = this.config.discoverySource ?? "dexscreener";
    const maxPoolAgeSec = this.config.maxPoolAgeSec ?? 0;
    const minRequestIntervalMs = this.config.minRequestIntervalMs ?? 2000;

    this.logger.info("STARTUP", `Session ${sessionId} initialized in ${sessionDir}`);
    this.logger.info(
      "CONFIG",
      `network=${this.config.network}, discoverySource=${discoverySource}, maxPoolAgeSec=${maxPoolAgeSec}, minRequestIntervalMs=${minRequestIntervalMs}, pollIntervalSec=${this.config.pollIntervalSec}, durationSec=${this.config.durationSec}, targetCandidates=${this.config.targetCandidates}, targetDiagnosticYield=${this.config.targetDiagnosticYield}, rpcUrl=${this.config.rpcUrl}`,
    );

    if (discoverySource === "raydium") {
      this.raydiumClient = new RaydiumLiveDiscoveryClient({
        pollIntervalMs: this.config.pollIntervalSec * 1000,
        minRequestIntervalMs,
        maxPoolAgeSec,
        transport: this.config.httpTransport,
        onLog: (msg) => this.logger.info("RAYDIUM_API", msg),
      });
      this.logger.info("DISCOVERY", "Raydium API v3 catalog discovery client initialized");
    } else {
      this.discoveryClient = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: this.config.pollIntervalSec * 1000,
        transport: this.config.httpTransport,
        onLog: (msg) => this.logger.info("DEXSCREENER", msg),
      });
      this.logger.info(
        "DISCOVERY",
        "DexScreener promotional profiles discovery client initialized",
      );
    }

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

        // 1b. Process deferred RPC verification retries (D25-F1)
        await this.processDeferredVerifications(now);

        // 2. Candidate target checks
        // A. Desired verified WATCHLIST_RADAR yield reached (disabled when targetDiagnosticYield === 0)
        if (
          this.config.targetDiagnosticYield > 0 &&
          this.runner.getStats().radar >= this.config.targetDiagnosticYield
        ) {
          this.stopReason = "TARGET_YIELD_REACHED";
          this.logger.info(
            "STOPPING",
            `Target diagnostic yield reached (${this.runner.getStats().radar} >= ${this.config.targetDiagnosticYield} verified Raydium AMM candidates). Stopping.`,
          );
          break;
        }

        // B. Safety ceiling for total screened candidates reached (D25-F2)
        const maxScreenedCeiling =
          this.config.maxCandidatesScreened ?? this.config.targetCandidates;
        if (this.runner.getStats().candidates >= maxScreenedCeiling) {
          this.stopReason = "MAX_CANDIDATES_SCREENED_REACHED";
          this.logger.info(
            "STOPPING",
            `Max screened candidates safety ceiling reached (${this.runner.getStats().candidates} >= ${maxScreenedCeiling}). Stopping.`,
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
        interface UnifiedDiscoveredItem {
          readonly candidate: D23ScreenedCandidate;
          readonly poolId: string | null;
          readonly volume5mUsd: number | null;
          readonly buys5m: number | null;
          readonly sells5m: number | null;
        }

        let discovered: UnifiedDiscoveredItem[] = [];

        if (this.config.discoverySource === "raydium" && this.raydiumClient) {
          if (this.raydiumClient.isPollDue()) {
            this.logger.info(
              "DISCOVERY_POLL",
              `Executing Raydium catalog discovery poll... (Pools seen so far: ${this.raydiumClient.getSeenPoolIdsCount()})`,
            );
            const raydiumDiscovered = await this.raydiumClient.pollDiscoveredCandidates({
              sessionId,
              generationId,
            });

            if (raydiumDiscovered.length > 0) {
              this.logger.info(
                "DISCOVERY_POLL",
                `Discovered ${raydiumDiscovered.length} candidate record(s) from Raydium catalog.`,
              );
              discovered = raydiumDiscovered.map((item) => ({
                candidate: item.candidate,
                poolId: item.poolSummary.poolId,
                volume5mUsd: item.poolSummary.volume5mUsd,
                buys5m: item.poolSummary.buys5m,
                sells5m: item.poolSummary.sells5m,
              }));
            }
          }
        } else if (this.discoveryClient) {
          if (this.discoveryClient.isPollDue()) {
            this.logger.info(
              "DISCOVERY_POLL",
              `Executing discovery poll... (Mints seen so far: ${this.discoveryClient.getSeenMintsCount()})`,
            );
            const dexDiscovered = await this.discoveryClient.pollDiscoveredCandidates({
              sessionId,
              generationId,
            });

            if (dexDiscovered.length > 0) {
              this.logger.info(
                "DISCOVERY_POLL",
                `Discovered ${dexDiscovered.length} candidate record(s) to process.`,
              );
              discovered = dexDiscovered.map((item) => ({
                candidate: item.candidate,
                poolId: item.pairSummary?.poolId ?? null,
                volume5mUsd: item.pairSummary?.volume5mUsd ?? null,
                buys5m: item.pairSummary?.buys5m ?? null,
                sells5m: item.pairSummary?.sells5m ?? null,
              }));
            }
          }
        }

        for (let itemIndex = 0; itemIndex < discovered.length; itemIndex++) {
          if (!this.isRunning) {
            this.unreachedCandidatesDueToStopping += discovered.length - itemIndex;
            break;
          }
          const item = discovered[itemIndex]!;
          const { candidate, poolId, volume5mUsd, buys5m, sells5m } = item;

          if (candidate.passedEligibility && poolId) {
            this.verificationAttempts++;
            // Confirm Raydium AMM on-chain via Solana RPC
            try {
              this.logger.info(
                "RPC_VERIFY",
                `Verifying Raydium pool ${poolId} on-chain for candidate ${candidate.compositeId.mintAddress} (${candidate.symbol})...`,
              );
              const obsResult = await this.rpcClient.observeRaydiumPool({
                poolAddress: poolId,
                targetMint: candidate.compositeId.mintAddress,
                flowMetrics: {
                  volume5mUsd,
                  buys5m,
                  sells5m,
                  netBuyerVolumeUsd: null,
                },
                compositeId: candidate.compositeId,
              });

              if (obsResult.ok && obsResult.observation) {
                this.verifiedAmmV4Pools++;
                const decisionEpochMs = Math.max(Date.now(), obsResult.observation.receiptEpochMs);
                const causalCandidate: D23ScreenedCandidate = {
                  ...candidate,
                  decisionEpochMs,
                };
                await this.runner.recordScreenedCandidate(causalCandidate, obsResult.observation);

                this.logger.info(
                  "CANDIDATE_RECORDED",
                  `[WATCHLIST_RADAR] Mint: ${candidate.compositeId.mintAddress} (${candidate.symbol}) | Pool: ${poolId} | Slot: ${obsResult.observation.onChainSlot} | Total screened: ${this.runner.getStats().candidates}`,
                );

                if (this.forwardTracker) {
                  this.forwardTracker.registerCandidateForForwardObservation(
                    causalCandidate,
                    obsResult.observation,
                  );
                }
              } else {
                const rawErr = obsResult.error ?? "RPC_OBSERVATION_FAILED";
                const classification = classifyRpcVerificationError(rawErr);

                if (classification.type === "TRANSIENT_PROVIDER_ERROR") {
                  this.rpcProviderUnavailable++;
                  // Transient RPC provider error (429, timeout, network failure)
                  // Do NOT count as confirmed protocol failure or immediately reject (D25-F1)
                  this.logger.warn(
                    "RPC_VERIFY_DEFERRED",
                    `Pool ${poolId} encountered transient error [${classification.reasonCode}]: ${rawErr}. Deferring verification (attempt 1/${MAX_RPC_VERIFICATION_RETRIES}).`,
                  );
                  this.deferredVerificationQueue.push({
                    candidate,
                    poolId,
                    volume5mUsd,
                    buys5m,
                    sells5m,
                    retryCount: 1,
                    lastAttemptEpochMs: Date.now(),
                    lastError: `${classification.reasonCode}:${rawErr}`,
                  });
                } else {
                  this.confirmedOnChainIneligible++;
                  // Confirmed on-chain ineligibility (unauthorized program owner, null account, malformed data, vault mismatch)
                  const rpcErr = classification.reasonCode;
                  this.logger.warn(
                    "RPC_VERIFY_INELIGIBLE",
                    `Pool ${poolId} confirmed on-chain ineligibility [${rpcErr}]: ${rawErr}. Recording as FILTERED_REJECTED.`,
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
                        observed: "confirmed_ineligible",
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

          // Check if candidate targets reached during candidate loop (disabled when targetDiagnosticYield === 0)
          if (
            this.config.targetDiagnosticYield > 0 &&
            this.runner.getStats().radar >= this.config.targetDiagnosticYield
          ) {
            this.stopReason = "TARGET_YIELD_REACHED";
            this.isRunning = false;
            const unreachedInBatch = discovered.length - 1 - itemIndex;
            if (unreachedInBatch > 0) {
              this.unreachedCandidatesDueToStopping += unreachedInBatch;
            }
            break;
          }
          if (
            this.runner.getStats().candidates >=
            (this.config.maxCandidatesScreened ?? this.config.targetCandidates)
          ) {
            this.stopReason = "MAX_CANDIDATES_SCREENED_REACHED";
            this.isRunning = false;
            const unreachedInBatch = discovered.length - 1 - itemIndex;
            if (unreachedInBatch > 0) {
              this.unreachedCandidatesDueToStopping += unreachedInBatch;
            }
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
        const deferredCount = this.deferredVerificationQueue.length;

        if (now - lastHeartbeatEpochMs >= 30_000) {
          lastHeartbeatEpochMs = now;
          const seenStats =
            this.config.discoverySource === "raydium" && this.raydiumClient
              ? `Seen Pools: ${this.raydiumClient.getSeenPoolIdsCount()}`
              : `Seen Mints: ${this.discoveryClient?.getSeenMintsCount() ?? 0}`;
          this.logger.info(
            "HEARTBEAT",
            `Elapsed: ${elapsedSec}s | Screened: ${currentStats.candidates} (Radar: ${currentStats.radar}, Rejected: ${currentStats.rejected}) | Deferred: ${deferredCount} | ${seenStats} | RPC: ${rpcDiag.totalCalls} calls (${rpcDiag.successfulCalls} ok, ${rpcDiag.failedCalls} fail) | Fwd Pending: ${fwdPending} | RSS: ${rssMb} MB`,
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

    // Drain any remaining deferred RPC verification candidates before forward drainage
    await this.drainRemainingDeferredVerifications(finalStopReason);

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

    // D26-F3: Assemble and seal full discovery funnel metrics
    if (this.config.discoverySource === "raydium" && this.raydiumClient) {
      const raydiumFunnel = this.raydiumClient.getFunnelMetrics();
      const funnelMetrics: DiscoveryFunnelMetrics = {
        apiPoolsReturned: raydiumFunnel.apiPoolsReturned,
        uniquePoolsEncountered: raydiumFunnel.uniquePoolsEncountered,
        repeatedPoolsSuppressed: raydiumFunnel.repeatedPoolsSuppressed,
        initialSnapshotPoolsEncountered: raydiumFunnel.initialSnapshotPoolsEncountered,
        laterPollArrivalsEncountered: raydiumFunnel.laterPollArrivalsEncountered,
        preVerificationExclusions: raydiumFunnel.preVerificationExclusions,
        poolAgeClassifications: raydiumFunnel.poolAgeClassifications,
        eligibleForVerification: raydiumFunnel.eligibleForVerification,
        verificationAttempts: this.verificationAttempts,
        verifiedAmmV4Pools: this.verifiedAmmV4Pools,
        confirmedOnChainIneligible: this.confirmedOnChainIneligible,
        rpcProviderUnavailable: this.rpcProviderUnavailable,
        rpcRetriesExhausted: this.rpcRetriesExhausted,
        unreachedCandidatesDueToStopping: this.unreachedCandidatesDueToStopping,
      };
      this.runner.setDiscoveryFunnel(funnelMetrics);
      this.logger.info("DISCOVERY_FUNNEL", JSON.stringify(funnelMetrics, null, 2));
    }

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
  runPilotCollectorCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[UNCAUGHT_FATAL] ${err}`);
      process.exitCode = 1;
    });
}
