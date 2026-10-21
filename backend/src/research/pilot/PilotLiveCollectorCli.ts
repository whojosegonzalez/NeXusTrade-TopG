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
import crypto from "node:crypto";
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
  type CpmmPoolVerificationReport,
  DEFAULT_SOLANA_MAINNET_RPC,
  sanitizeSolanaRpcUrl,
} from "./SolanaRpcLiveObservationClient.js";
import { ForwardOutcomeObservationTracker } from "./ForwardOutcomeObservationTracker.js";
import { verifySessionExportManifest } from "./PilotExportManifest.js";
import { D23_STRATEGY_REVISION } from "./PilotSchemaBridge.js";
import type { D23ScreenedCandidate } from "./PilotTypes.js";
import type { DiscoveryFunnelMetrics } from "../../telemetry/TelemetryTypes.js";
import {
  EventDiscoveryIngestionEngine,
  type ITransactionFetcher,
} from "./EventDiscoveryIngestionEngine.js";
import { verifyB2SessionManifest } from "./EventSessionEvidenceCapture.js";
import type {
  DiscoveredPoolAccountPayload,
  EventDiscoveryMetricsSnapshot,
  IOnChainAccountFetcher,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import {
  createAuthoritativeRaydiumCpmmBuffer,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { createAuthoritativeCpmmSplVaultBuffer } from "./fixtures/AuthoritativeEventFixtures.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";

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
  readonly discoverySource?: "dexscreener" | "raydium" | "events" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
  readonly logFilePath?: string | undefined;
  readonly verifyPoolAddress?: string | undefined;
  readonly verifyCpmmPoolAddress?: string | undefined;
  readonly replayFixturesPath?: string | undefined;
  readonly captureFixturesDir?: string | undefined;
  readonly replayMode?: "synthetic" | "authentic" | undefined;
  readonly rpcMaxCalls?: number | undefined;
  readonly rpcTimeoutMs?: number | undefined;
  readonly wsUrl?: string | undefined;
  readonly maxWsMessages?: number | undefined;
  readonly maxEvents?: number | undefined;
  readonly maxTransactions?: number | undefined;
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
  let discoverySource: "dexscreener" | "raydium" | "events" = "dexscreener";
  let maxPoolAgeSec = 0;
  let minRequestIntervalMs = 2000;
  let logFilePath: string | undefined = undefined;
  let verifyPoolAddress: string | undefined = undefined;
  let verifyCpmmPoolAddress: string | undefined = undefined;
  let replayFixturesPath: string | undefined = undefined;
  let captureFixturesDir: string | undefined = undefined;
  let maxEvents: number | undefined = undefined;
  let maxTransactions: number | undefined = undefined;
  let replayMode: "synthetic" | "authentic" | undefined = undefined;
  let rpcMaxCalls: number | undefined = undefined;
  let rpcTimeoutMs: number | undefined = undefined;
  let wsUrl: string | undefined = undefined;
  let maxWsMessages: number | undefined = undefined;

  // Linux default: ~/nexustrade-pilot-data/sessions/
  // Windows default: .tmp/pilot-data/sessions/
  const defaultDir =
    process.platform === "win32"
      ? path.resolve(".tmp/pilot-data/sessions")
      : path.join(os.homedir(), "nexustrade-pilot-data", "sessions");
  let outputDir = defaultDir;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`NeXusTrade Pilot Live Collector CLI (Phase 12.94-D.2.4 / D.2.5 / D.2.9)
Usage: node backend/dist/research/pilot/PilotLiveCollectorCli.js [options]

Required:
  --network=enabled                Explicit authorization required to perform read-only network collection

Options:
  --verify-pool=<address>          Perform independent on-chain Raydium AMM v4 verification and print report
  --verify-cpmm-pool=<address>     Perform independent on-chain Raydium CPMM verification and print report (D29-H3)
  --replay-fixtures=<path>         Replay recorded event/transaction fixtures offline without network (D29-H3)
  --replay-mode=synthetic|authentic Replay fidelity mode (default: synthetic, authentic requires sealed manifest) (B1-PREP-04)
  --capture-fixtures-dir=<dir>     Directory to persist captured raw immutable fixtures (D29-H3 / B1-PREP-01)
  --rpc-url=<url>                  Solana RPC endpoint URL (default: https://api.mainnet-beta.solana.com)
  --ws-url=<url>                   Solana WebSocket endpoint URL (default: wss://api.mainnet-beta.solana.com) (D29-B2)
  --rpc-max-calls=<n>              Outbound RPC call ceiling budget (default: 2 in CPMM verification mode) (B1-PREP-03)
  --rpc-timeout-ms=<n>             HTTP RPC request timeout in ms (default: 10000)
  --discovery-source=dexscreener|raydium|events Discovery source adapter (default: dexscreener)
  --max-ws-messages=<n>            Maximum WebSocket incoming messages budget (default: 500) (D29-B2)
  --max-events=<n>                 Maximum event budget for event discovery (default: 50)
  --max-transactions=<n>           Maximum fetched transactions budget (default: 25)
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
      if (val !== "dexscreener" && val !== "raydium" && val !== "events") {
        throw new Error(
          `[INVALID_ARGUMENT] Option '--discovery-source' must be 'dexscreener', 'raydium', or 'events', got '${val}'`,
        );
      }
      discoverySource = val as "dexscreener" | "raydium" | "events";
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
    } else if (arg.startsWith("--verify-cpmm-pool=")) {
      const val = arg.slice("--verify-cpmm-pool=".length).trim();
      if (!val) {
        throw new Error(
          "[INVALID_ARGUMENT] Option '--verify-cpmm-pool' requires a non-empty address",
        );
      }
      verifyCpmmPoolAddress = val;
    } else if (arg.startsWith("--replay-fixtures=")) {
      const val = arg.slice("--replay-fixtures=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--replay-fixtures' requires a non-empty path");
      }
      replayFixturesPath = path.resolve(val);
    } else if (arg.startsWith("--replay-mode=")) {
      const val = arg.slice("--replay-mode=".length).trim().toLowerCase();
      if (val !== "synthetic" && val !== "authentic") {
        throw new Error(
          `[INVALID_ARGUMENT] Option '--replay-mode' must be 'synthetic' or 'authentic', got '${val}'`,
        );
      }
      replayMode = val as "synthetic" | "authentic";
    } else if (arg.startsWith("--rpc-max-calls=")) {
      rpcMaxCalls = parsePositiveInt("--rpc-max-calls", arg.slice("--rpc-max-calls=".length));
    } else if (arg.startsWith("--rpc-timeout-ms=")) {
      rpcTimeoutMs = parsePositiveInt("--rpc-timeout-ms", arg.slice("--rpc-timeout-ms=".length));
    } else if (arg.startsWith("--capture-fixtures-dir=")) {
      const val = arg.slice("--capture-fixtures-dir=".length).trim();
      if (!val) {
        throw new Error(
          "[INVALID_ARGUMENT] Option '--capture-fixtures-dir' requires a non-empty directory path",
        );
      }
      captureFixturesDir = path.resolve(val);
    } else if (arg.startsWith("--max-events=")) {
      maxEvents = parsePositiveInt("--max-events", arg.slice("--max-events=".length));
    } else if (arg.startsWith("--max-transactions=")) {
      maxTransactions = parsePositiveInt(
        "--max-transactions",
        arg.slice("--max-transactions=".length),
      );
    } else if (arg.startsWith("--rpc-url=")) {
      const val = arg.slice("--rpc-url=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--rpc-url' requires a non-empty URL");
      }
      rpcUrl = val;
    } else if (arg.startsWith("--ws-url=")) {
      const val = arg.slice("--ws-url=".length).trim();
      if (!val) {
        throw new Error("[INVALID_ARGUMENT] Option '--ws-url' requires a non-empty URL");
      }
      wsUrl = val;
    } else if (arg.startsWith("--max-ws-messages=")) {
      maxWsMessages = parsePositiveInt("--max-ws-messages", arg.slice("--max-ws-messages=".length));
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
    verifyCpmmPoolAddress,
    replayFixturesPath,
    captureFixturesDir,
    replayMode,
    rpcMaxCalls,
    rpcTimeoutMs,
    wsUrl,
    maxWsMessages,
    maxEvents,
    maxTransactions,
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
      `network=${this.config.network}, discoverySource=${discoverySource}, maxPoolAgeSec=${maxPoolAgeSec}, minRequestIntervalMs=${minRequestIntervalMs}, pollIntervalSec=${this.config.pollIntervalSec}, durationSec=${this.config.durationSec}, targetCandidates=${this.config.targetCandidates}, targetDiagnosticYield=${this.config.targetDiagnosticYield}, rpcUrl=${sanitizeSolanaRpcUrl(this.config.rpcUrl).sanitizedUrl}`,
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
    } else if (discoverySource === "events") {
      throw new Error(
        "[DISCOVERY_UNAUTHORIZED] Live event-driven discovery is deferred to Milestone D.2.9-B upon authorization. Use --replay-fixtures=<path> for offline event verification.",
      );
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
        malformedRawEntries: raydiumFunnel.malformedRawEntries,
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

export interface CpmmSnapshotManifestFileEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface CpmmSnapshotManifest {
  readonly manifestVersion: "1.0";
  readonly snapshotId: string;
  readonly createdAtIso: string;
  readonly status: "FINALIZED" | "FAILED" | "INTERRUPTED";
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly CpmmSnapshotManifestFileEntry[];
  readonly manifestSha256: string;
}

/**
 * Persists raw on-chain CPMM JSON-RPC response payloads, execution metadata, and sealed SHA-256 manifest (B1-PREP-01).
 * Isolates fixtures in a session-unique subdirectory under captureFixturesDir.
 */
export function saveCpmmSnapshot(
  captureFixturesDir: string,
  poolAddress: string,
  report: CpmmPoolVerificationReport,
  logger?: PilotLogger | undefined,
  forcedStatus?: "FINALIZED" | "FAILED" | "INTERRUPTED",
): {
  snapshotDir: string;
  manifestPath: string;
  status: "FINALIZED" | "FAILED" | "INTERRUPTED";
  manifest: CpmmSnapshotManifest;
} {
  const snapshotTimestamp = Date.now();
  const snapshotId = `cpmm-snapshot-${snapshotTimestamp}`;
  const targetDir = path.join(captureFixturesDir, snapshotId);
  fsSync.mkdirSync(targetDir, { recursive: true });

  const status: "FINALIZED" | "FAILED" | "INTERRUPTED" =
    forcedStatus ?? (report.verified ? "FINALIZED" : "FAILED");

  // 1. pool-account-rpc.json
  const poolAccountRpcData = report.rawCaptureBundle?.poolAccountRpc ?? {
    request: {
      jsonrpc: "2.0" as const,
      id: "capture-req-pool",
      method: "getAccountInfo",
      params: [
        poolAddress,
        { encoding: "base64", commitment: report.requestedCommitment ?? "confirmed" },
      ],
      endpoint: report.rpcUrl,
      timestampIso: new Date(snapshotTimestamp).toISOString(),
      timestampEpochMs: snapshotTimestamp,
    },
    response: null,
    timing: { elapsedMs: report.hostElapsedMs ?? 0, payloadSizeBytes: 0 },
    error: report.error ?? "No raw pool RPC record available",
  };
  const poolFilePath = path.join(targetDir, "pool-account-rpc.json");
  fsSync.writeFileSync(poolFilePath, JSON.stringify(poolAccountRpcData, null, 2), "utf8");

  // 2. vault-accounts-rpc.json
  const vaultAccountsRpcData = report.rawCaptureBundle?.vaultAccountsRpc ?? {
    request: {
      jsonrpc: "2.0" as const,
      id: "capture-req-vaults",
      method: "getMultipleAccounts",
      params: [
        [report.token0Vault ?? "", report.token1Vault ?? ""],
        { encoding: "base64", commitment: report.requestedCommitment ?? "confirmed" },
      ],
      endpoint: report.rpcUrl,
      timestampIso: new Date(snapshotTimestamp).toISOString(),
      timestampEpochMs: snapshotTimestamp,
    },
    response: null,
    timing: { elapsedMs: 0, payloadSizeBytes: 0 },
    error: report.rawCaptureBundle?.vaultAccountsRpc
      ? undefined
      : "Vault accounts RPC call not executed",
  };
  const vaultsFilePath = path.join(targetDir, "vault-accounts-rpc.json");
  fsSync.writeFileSync(vaultsFilePath, JSON.stringify(vaultAccountsRpcData, null, 2), "utf8");

  // 3. cpmm-verification-report.json
  const cleanReport = { ...report };
  delete (cleanReport as { rawCaptureBundle?: unknown }).rawCaptureBundle;
  const reportFilePath = path.join(targetDir, "cpmm-verification-report.json");
  fsSync.writeFileSync(
    reportFilePath,
    JSON.stringify(cleanReport, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    "utf8",
  );

  // 4. snapshot-metadata.json
  const slotDelta =
    report.poolSlot !== null && report.vault0Slot !== null
      ? Math.abs(report.poolSlot - report.vault0Slot)
      : null;
  const requestedCommitment =
    report.requestedCommitment ??
    (
      report.rawCaptureBundle?.poolAccountRpc?.request?.params?.[1] as
        | { commitment?: string }
        | undefined
    )?.commitment ??
    "unspecified";

  const metadata = {
    snapshotId,
    captureTimestampIso: new Date(snapshotTimestamp).toISOString(),
    captureTimestampEpochMs: snapshotTimestamp,
    poolAddress,
    token0Vault: report.token0Vault ?? null,
    token1Vault: report.token1Vault ?? null,
    rpcUrl: report.rpcUrl,
    rpcHost:
      report.endpointHost ?? (report.rpcUrl ? sanitizeSolanaRpcUrl(report.rpcUrl).host : null),
    rpcFingerprint:
      report.endpointFingerprint ??
      (report.rpcUrl ? sanitizeSolanaRpcUrl(report.rpcUrl).endpointFingerprint : null),
    commitment: requestedCommitment,
    wirePayloadPreservation: "JSON_RPC_OBJECTS_BASE64",
    maxRpcCallsCeiling: report.rawCaptureBundle?.maxRpcCallsBudget ?? 2,
    totalRpcCallsExecuted:
      report.rawCaptureBundle?.totalRpcCalls ?? (vaultAccountsRpcData.response ? 2 : 1),
    status,
    verificationStatus: report.verificationStatus,
    verified: report.verified,
    verificationTier: report.verificationTier ?? null,
    poolSlot: report.poolSlot,
    vaultsSlot: report.vault0Slot,
    slotDelta,
    error: report.error ?? null,
  };
  const metadataFilePath = path.join(targetDir, "snapshot-metadata.json");
  fsSync.writeFileSync(metadataFilePath, JSON.stringify(metadata, null, 2), "utf8");

  // 5. Generate SHA-256 Manifest (cpmm-snapshot-manifest.json)
  const filesToSeal = [
    "pool-account-rpc.json",
    "vault-accounts-rpc.json",
    "cpmm-verification-report.json",
    "snapshot-metadata.json",
  ];

  const fileEntries: CpmmSnapshotManifestFileEntry[] = [];
  let totalBytes = 0;

  for (const filename of filesToSeal) {
    const filePath = path.join(targetDir, filename);
    const content = fsSync.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    fileEntries.push({
      filename,
      sha256: hash,
      byteSize: content.length,
    });
    totalBytes += content.length;
  }

  // Sort files deterministically by filename
  fileEntries.sort((a, b) => a.filename.localeCompare(b.filename));

  const manifestPayload = fileEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const manifestSha256 = crypto.createHash("sha256").update(manifestPayload).digest("hex");

  const manifest: CpmmSnapshotManifest = {
    manifestVersion: "1.0",
    snapshotId,
    createdAtIso: new Date(snapshotTimestamp).toISOString(),
    status,
    totalFiles: fileEntries.length,
    totalBytes,
    files: fileEntries,
    manifestSha256,
  };

  const manifestFilePath = path.join(targetDir, "cpmm-snapshot-manifest.json");
  fsSync.writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2), "utf8");

  logger?.info(
    "CPMM_SNAPSHOT_SEALED",
    `Sealed raw CPMM snapshot [${status}] in ${targetDir} with SHA-256 manifest ${manifestFilePath} (manifestSha256: ${manifestSha256})`,
  );

  return {
    snapshotDir: targetDir,
    manifestPath: manifestFilePath,
    status,
    manifest,
  };
}

/**
 * Parses an account payload from arbitrary JSON fixture representations.
 */
export function parseAccountPayload(
  rawAcc: unknown,
  defaultSlot: number = 300000100,
): DiscoveredPoolAccountPayload | null {
  if (!rawAcc || typeof rawAcc !== "object") return null;
  const acc = rawAcc as Record<string, unknown>;
  const address = typeof acc.address === "string" ? acc.address : undefined;
  if (!address) return null;

  let dataBuf: Buffer;
  const rawData = acc.data ?? acc.dataBase64 ?? acc.accountData;
  if (Buffer.isBuffer(rawData)) {
    dataBuf = rawData;
  } else if (rawData instanceof Uint8Array) {
    dataBuf = Buffer.from(rawData);
  } else if (Array.isArray(rawData)) {
    if (rawData.length === 2 && typeof rawData[0] === "string" && rawData[1] === "base64") {
      dataBuf = Buffer.from(rawData[0], "base64");
    } else {
      dataBuf = Buffer.from(rawData as number[]);
    }
  } else if (typeof rawData === "string") {
    dataBuf = Buffer.from(rawData, "base64");
  } else {
    dataBuf = Buffer.alloc(0);
  }

  const owner = typeof acc.owner === "string" ? acc.owner : "";
  const lamports =
    typeof acc.lamports === "bigint" || typeof acc.lamports === "number"
      ? BigInt(acc.lamports)
      : 0n;
  const slot =
    typeof acc.slot === "number" && Number.isInteger(acc.slot) && acc.slot > 0
      ? acc.slot
      : defaultSlot;

  return {
    address,
    data: dataBuf,
    owner,
    lamports,
    slot,
  };
}

export const EXPECTED_CPMM_EVIDENCE_FILES = [
  "cpmm-verification-report.json",
  "pool-account-rpc.json",
  "snapshot-metadata.json",
  "vault-accounts-rpc.json",
] as const;

/**
 * Loads synthetic and recorded account payloads from replay fixtures directory or file (BREADY-05 / B1-PREP-04).
 * When options.replayMode === 'authentic', strictly verifies against sealed SHA-256 manifest and forbids synthetic fallbacks.
 */
export function loadAccountMapFromFixtures(
  fixturesPath: string,
  options?: { replayMode?: "synthetic" | "authentic" | undefined },
): Map<string, DiscoveredPoolAccountPayload> {
  const accountMap = new Map<string, DiscoveredPoolAccountPayload>();
  if (!fsSync.existsSync(fixturesPath)) return accountMap;

  // Authentic Replay Mode (B1-PREP-04 / B1-EVIDENCE-01 / D29-B2): Strict verification against sealed SHA-256 manifest
  if (options?.replayMode === "authentic") {
    const stat = fsSync.statSync(fixturesPath);
    const targetDir = stat.isDirectory() ? fixturesPath : path.dirname(fixturesPath);

    // Support B2 Event Discovery session manifest
    if (fsSync.existsSync(path.join(targetDir, "session-manifest.json"))) {
      verifyB2SessionManifest(targetDir);
      const rawAccountsPath = path.join(targetDir, "raw-accounts.jsonl");
      if (fsSync.existsSync(rawAccountsPath)) {
        const rawLines = fsSync.readFileSync(rawAccountsPath, "utf8").trim().split("\n");
        for (const line of rawLines) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            const req = record.request;
            const res = record.response;
            if (req?.method === "getAccountInfo") {
              const addr = req.params?.[0];
              const val = res?.result?.value ?? res?.value;
              const slot = res?.result?.context?.slot ?? res?.context?.slot ?? 300000100;
              if (addr && val?.data?.[0]) {
                accountMap.set(addr, {
                  address: addr,
                  data: Buffer.from(val.data[0], "base64"),
                  owner: val.owner ?? "",
                  lamports: BigInt(val.lamports ?? 0),
                  slot,
                });
              }
            } else if (req?.method === "getMultipleAccounts") {
              const addrs = req.params?.[0] as string[];
              const vals = res?.result?.value ?? res?.value;
              const slot = res?.result?.context?.slot ?? res?.context?.slot ?? 300000100;
              if (Array.isArray(addrs) && Array.isArray(vals)) {
                for (let i = 0; i < addrs.length; i++) {
                  const addr = addrs[i];
                  const val = vals[i];
                  if (addr && val?.data?.[0]) {
                    accountMap.set(addr, {
                      address: addr,
                      data: Buffer.from(val.data[0], "base64"),
                      owner: val.owner ?? "",
                      lamports: BigInt(val.lamports ?? 0),
                      slot,
                    });
                  }
                }
              }
            }
          } catch {
            // ignore malformed line
          }
        }
      }
      return accountMap;
    }

    const manifestName = fsSync.existsSync(path.join(targetDir, "cpmm-snapshot-manifest.json"))
      ? "cpmm-snapshot-manifest.json"
      : fsSync.existsSync(path.join(targetDir, "manifest.json"))
        ? "manifest.json"
        : null;

    if (!manifestName) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Authentic replay requires a sealed manifest (cpmm-snapshot-manifest.json). None found in ${targetDir}`,
      );
    }

    const manifestPath = path.join(targetDir, manifestName);
    const manifestRaw = fsSync.readFileSync(manifestPath, "utf8");
    let manifest: {
      manifestVersion?: string;
      snapshotId?: string;
      createdAtIso?: string;
      status?: string;
      totalFiles?: number;
      totalBytes?: number;
      files?: Array<{ filename: string; sha256: string; byteSize: number }>;
      manifestSha256?: string;
    };
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      throw new Error(`[AUTHENTIC_REPLAY_ERROR] Failed to parse manifest JSON in ${manifestPath}`);
    }

    if (!manifest || typeof manifest !== "object") {
      throw new Error(`[AUTHENTIC_REPLAY_ERROR] Manifest in ${manifestPath} must be a JSON object`);
    }

    // B1-EVIDENCE-01.3 & 01.4: Strict validation of totalFiles, totalBytes, and files list
    if (!Array.isArray(manifest.files)) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Manifest in ${manifestPath} contains no valid files array`,
      );
    }

    if (manifest.files.length !== EXPECTED_CPMM_EVIDENCE_FILES.length) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Invalid manifest file count: expected exactly ${EXPECTED_CPMM_EVIDENCE_FILES.length} evidence files, got ${manifest.files.length}`,
      );
    }

    if (manifest.totalFiles !== EXPECTED_CPMM_EVIDENCE_FILES.length) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Manifest totalFiles mismatch: expected ${EXPECTED_CPMM_EVIDENCE_FILES.length}, got ${manifest.totalFiles}`,
      );
    }

    if (
      typeof manifest.manifestSha256 !== "string" ||
      manifest.manifestSha256.trim().length === 0
    ) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Manifest in ${manifestPath} is missing required manifestSha256 digest`,
      );
    }

    // Verify exactly the expected 4 evidence files with zero duplicates and zero missing
    const seenFiles = new Set<string>();
    let computedTotalBytes = 0;

    for (const entry of manifest.files) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`[AUTHENTIC_REPLAY_ERROR] Malformed file entry in ${manifestPath}`);
      }
      if (!entry.filename || typeof entry.filename !== "string") {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Manifest entry missing filename in ${manifestPath}`,
        );
      }
      if (seenFiles.has(entry.filename)) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Duplicate file entry in manifest: ${entry.filename}`,
        );
      }
      seenFiles.add(entry.filename);

      if (
        !EXPECTED_CPMM_EVIDENCE_FILES.includes(
          entry.filename as (typeof EXPECTED_CPMM_EVIDENCE_FILES)[number],
        )
      ) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Unexpected evidence file in manifest: '${entry.filename}'. Expected only canonical CPMM evidence files.`,
        );
      }

      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Invalid SHA-256 digest for '${entry.filename}' in manifest: ${entry.sha256}`,
        );
      }

      if (
        typeof entry.byteSize !== "number" ||
        !Number.isInteger(entry.byteSize) ||
        entry.byteSize <= 0
      ) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Invalid byteSize for '${entry.filename}' in manifest: ${entry.byteSize}`,
        );
      }
      computedTotalBytes += entry.byteSize;
    }

    for (const expectedFile of EXPECTED_CPMM_EVIDENCE_FILES) {
      if (!seenFiles.has(expectedFile)) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Manifest missing required evidence file: ${expectedFile}`,
        );
      }
    }

    if (manifest.totalBytes !== computedTotalBytes) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Manifest totalBytes inconsistency: declared ${manifest.totalBytes}, sum of entries is ${computedTotalBytes}`,
      );
    }

    // B1-EVIDENCE-01.1: Canonical calculation and verification of manifestSha256
    // NOTE ON INTEGRITY: Local SHA-256 hashes establish internal tamper-evidence and file consistency across the captured snapshot set.
    // They do NOT provide independent cryptographic proof of blockchain origin (which requires RPC cryptographic signatures / Merkle proofs)
    // nor do they protect against an adversarial operator replacing both the manifest and its contents in their entirety.
    const sortedEntries = [...manifest.files].sort((a, b) => a.filename.localeCompare(b.filename));
    const canonicalPayload = sortedEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
    const canonicalManifestSha256 = crypto
      .createHash("sha256")
      .update(canonicalPayload)
      .digest("hex");
    if (canonicalManifestSha256 !== manifest.manifestSha256) {
      throw new Error(
        `[STRICT_REPLAY_INTEGRITY_FAILURE] Canonical manifestSha256 mismatch: manifest declared ${manifest.manifestSha256}, computed ${canonicalManifestSha256}`,
      );
    }

    // B1-EVIDENCE-01.2: Verify each file's actual byte size and SHA-256 against disk
    for (const entry of manifest.files) {
      const filePath = path.join(targetDir, entry.filename);
      if (!fsSync.existsSync(filePath)) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Missing sealed fixture file: ${entry.filename} (listed in ${manifestName})`,
        );
      }
      const fileBytes = fsSync.readFileSync(filePath);
      if (fileBytes.byteLength !== entry.byteSize) {
        throw new Error(
          `[STRICT_REPLAY_INTEGRITY_FAILURE] Byte size mismatch for '${entry.filename}': manifest expected ${entry.byteSize} bytes, disk file is ${fileBytes.byteLength} bytes`,
        );
      }
      const actualHash = crypto.createHash("sha256").update(fileBytes).digest("hex");
      if (actualHash !== entry.sha256) {
        throw new Error(
          `[STRICT_REPLAY_INTEGRITY_FAILURE] SHA-256 hash mismatch for '${entry.filename}': expected ${entry.sha256}, got ${actualHash}`,
        );
      }
    }

    // 1. Load Pool Account from pool-account-rpc.json
    const poolFilePath = path.join(targetDir, "pool-account-rpc.json");
    if (!fsSync.existsSync(poolFilePath)) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Missing required CPMM pool payload: pool-account-rpc.json`,
      );
    }
    const poolJson = JSON.parse(fsSync.readFileSync(poolFilePath, "utf8"));
    const poolReq = poolJson.request;
    const poolRes = poolJson.response;
    const poolAddress = poolReq?.params?.[0];
    const poolVal = poolRes?.result?.value ?? poolRes?.value;
    const poolSlot = poolRes?.result?.context?.slot ?? poolRes?.context?.slot;

    if (!poolAddress || typeof poolAddress !== "string") {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Missing or invalid pool address in ${poolFilePath}`,
      );
    }
    if (!poolVal || !poolVal.data?.[0]) {
      throw new Error(`[AUTHENTIC_REPLAY_ERROR] Missing pool account data in ${poolFilePath}`);
    }
    if (typeof poolSlot !== "number" || !Number.isInteger(poolSlot) || poolSlot <= 0) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Invalid non-positive context slot for pool account in ${poolFilePath}: ${poolSlot}`,
      );
    }
    accountMap.set(poolAddress, {
      address: poolAddress,
      data: Buffer.from(poolVal.data[0], "base64"),
      owner: poolVal.owner ?? "",
      lamports: BigInt(poolVal.lamports ?? 0),
      slot: poolSlot,
    });

    // 2. Load Vault Accounts from vault-accounts-rpc.json
    const vaultsFilePath = path.join(targetDir, "vault-accounts-rpc.json");
    if (!fsSync.existsSync(vaultsFilePath)) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Missing required CPMM vaults payload: vault-accounts-rpc.json`,
      );
    }
    const vaultsJson = JSON.parse(fsSync.readFileSync(vaultsFilePath, "utf8"));
    const vaultsReq = vaultsJson.request;
    const vaultsRes = vaultsJson.response;
    const vaultAddrs = vaultsReq?.params?.[0] as string[];
    const vaultVals = vaultsRes?.result?.value ?? vaultsRes?.value;
    const vaultsSlot = vaultsRes?.result?.context?.slot ?? vaultsRes?.context?.slot;

    if (!Array.isArray(vaultAddrs) || vaultAddrs.length !== 2) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Expected 2 vault addresses in ${vaultsFilePath}, got ${vaultAddrs?.length}`,
      );
    }
    if (!Array.isArray(vaultVals) || vaultVals.length !== 2) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Expected 2 vault account values in ${vaultsFilePath}, got ${vaultVals?.length}`,
      );
    }
    if (typeof vaultsSlot !== "number" || !Number.isInteger(vaultsSlot) || vaultsSlot <= 0) {
      throw new Error(
        `[AUTHENTIC_REPLAY_ERROR] Invalid non-positive context slot for vault accounts in ${vaultsFilePath}: ${vaultsSlot}`,
      );
    }

    for (let i = 0; i < 2; i++) {
      const addr = vaultAddrs[i];
      if (!addr || typeof addr !== "string") {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Missing vault address at index ${i} in ${vaultsFilePath}`,
        );
      }
      const vVal = vaultVals[i];
      if (!vVal || !vVal.data?.[0]) {
        throw new Error(
          `[AUTHENTIC_REPLAY_ERROR] Empty vault account ${i} payload in ${vaultsFilePath}`,
        );
      }
      accountMap.set(addr, {
        address: addr,
        data: Buffer.from(vVal.data[0], "base64"),
        owner: vVal.owner ?? "",
        lamports: BigInt(vVal.lamports ?? 0),
        slot: vaultsSlot,
      });
    }

    // STRICT REPLAY: Zero synthetic fallbacks permitted!
    return accountMap;
  }

  const stat = fsSync.statSync(fixturesPath);
  const fixtureFiles: string[] = [];
  if (stat.isDirectory()) {
    const entries = fsSync.readdirSync(fixturesPath);
    for (const e of entries) {
      if (e.endsWith(".json")) {
        fixtureFiles.push(path.join(fixturesPath, e));
      }
    }
  } else {
    fixtureFiles.push(fixturesPath);
  }

  let defaultSlot = 300000100;

  for (const filePath of fixtureFiles) {
    try {
      const raw = fsSync.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);

      if (parsed.slot && typeof parsed.slot === "number" && parsed.slot > 0) {
        defaultSlot = parsed.slot;
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.slot && typeof item.slot === "number" && item.slot > 0) {
            defaultSlot = item.slot;
          }
        }
      }

      // 1. Array of accounts or record map in parsed.accounts
      if (Array.isArray(parsed.accounts)) {
        for (const item of parsed.accounts) {
          const acc = parseAccountPayload(item, defaultSlot);
          if (acc) accountMap.set(acc.address, acc);
        }
      } else if (parsed.accounts && typeof parsed.accounts === "object") {
        for (const [addr, item] of Object.entries(parsed.accounts)) {
          const acc = parseAccountPayload({ address: addr, ...(item as object) }, defaultSlot);
          if (acc) accountMap.set(acc.address, acc);
        }
      }

      // 2. Single account in parsed.account
      if (parsed.account && typeof parsed.account === "object") {
        const acc = parseAccountPayload(parsed.account, defaultSlot);
        if (acc) accountMap.set(acc.address, acc);
      }

      // 3. Top-level account snapshot
      if (
        parsed.address &&
        (parsed.data !== undefined ||
          parsed.dataBase64 !== undefined ||
          parsed.accountData !== undefined)
      ) {
        const acc = parseAccountPayload(parsed, defaultSlot);
        if (acc) accountMap.set(acc.address, acc);
      }

      // 4. Root array of items
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            const acc = parseAccountPayload(item, defaultSlot);
            if (acc) accountMap.set(acc.address, acc);
          }
        }
      }
    } catch {
      // Ignore parse warnings on non-JSON files
    }
  }

  // Populate default authoritative synthetic fixtures for offline testing
  if (!accountMap.has(FIXTURE_CPMM_POOL_ADDRESS)) {
    accountMap.set(FIXTURE_CPMM_POOL_ADDRESS, {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer(),
      owner: RAYDIUM_CPMM_PROGRAM_ID,
      lamports: 10000000n,
      slot: defaultSlot,
    });
  }
  if (!accountMap.has(FIXTURE_CPMM_TOKEN_0_VAULT)) {
    accountMap.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: defaultSlot,
    });
  }
  if (!accountMap.has(FIXTURE_CPMM_TOKEN_1_VAULT)) {
    accountMap.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: defaultSlot,
    });
  }
  if (!accountMap.has(FIXTURE_POOL_ADDRESS)) {
    accountMap.set(FIXTURE_POOL_ADDRESS, {
      address: FIXTURE_POOL_ADDRESS,
      data: createAuthoritativeRaydiumAmmV4Buffer(),
      owner: RAYDIUM_AMM_V4_PROGRAM_ID,
      lamports: 10000000n,
      slot: defaultSlot,
    });
  }
  if (!accountMap.has(FIXTURE_BASE_VAULT)) {
    accountMap.set(FIXTURE_BASE_VAULT, {
      address: FIXTURE_BASE_VAULT,
      data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: defaultSlot,
    });
  }
  if (!accountMap.has(FIXTURE_QUOTE_VAULT)) {
    accountMap.set(FIXTURE_QUOTE_VAULT, {
      address: FIXTURE_QUOTE_VAULT,
      data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: defaultSlot,
    });
  }

  return accountMap;
}

/**
 * Constructs an offline mock RPC transport that serves accounts loaded from replay fixtures (BREADY-05 / B1-PREP-04).
 */
export function createOfflineRpcTransportFromFixtures(
  fixturesPath: string,
  options?: { replayMode?: "synthetic" | "authentic" | undefined },
): ISolanaRpcTransport {
  const accountMap = loadAccountMapFromFixtures(fixturesPath, options);

  return {
    async post(_url: string, body: Record<string, unknown>): Promise<unknown> {
      const method = body.method as string;
      const params = body.params as unknown[];
      const reqId = body.id ?? 1;

      if (method === "getAccountInfo") {
        const address = (params?.[0] as string) ?? "";
        const acc = accountMap.get(address);
        if (!acc) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            result: { context: { slot: 300000100 }, value: null },
          };
        }
        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            context: { slot: acc.slot },
            value: {
              data: [Buffer.from(acc.data).toString("base64"), "base64"],
              owner: acc.owner,
              lamports: Number(acc.lamports),
            },
          },
        };
      }

      if (method === "getMultipleAccounts") {
        const addresses = (params?.[0] as string[]) ?? [];
        let maxSlot = 300000100;
        const value = addresses.map((addr) => {
          const acc = accountMap.get(addr);
          if (!acc) return null;
          if (acc.slot > maxSlot) maxSlot = acc.slot;
          return {
            data: [Buffer.from(acc.data).toString("base64"), "base64"],
            owner: acc.owner,
            lamports: Number(acc.lamports),
          };
        });
        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            context: { slot: maxSlot },
            value,
          },
        };
      }

      if (method === "getSlot") {
        return {
          jsonrpc: "2.0",
          id: reqId,
          result: 300000100,
        };
      }

      throw new Error(
        `[OFFLINE_RPC] Method '${method}' not supported by offline fixture transport`,
      );
    },
  };
}

/**
 * Executes an offline event discovery replay session from recorded fixture files (D29-H3 / BREADY-05).
 */
export async function runReplaySession(
  config: PilotLiveCollectorConfig,
  logger: PilotLogger,
): Promise<{ ok: boolean; metrics: EventDiscoveryMetricsSnapshot; poolsVerified: number }> {
  if (!config.replayFixturesPath || !fsSync.existsSync(config.replayFixturesPath)) {
    throw new Error(`[REPLAY_ERROR] Fixtures path does not exist: ${config.replayFixturesPath}`);
  }

  const stat = fsSync.statSync(config.replayFixturesPath);
  const fixtureFiles: string[] = [];
  if (stat.isDirectory()) {
    const entries = fsSync.readdirSync(config.replayFixturesPath);
    for (const e of entries) {
      if (e.endsWith(".json")) {
        fixtureFiles.push(path.join(config.replayFixturesPath, e));
      }
    }
  } else {
    fixtureFiles.push(config.replayFixturesPath);
  }

  logger.info(
    "REPLAY_LOAD",
    `Loading ${fixtureFiles.length} fixture files from ${config.replayFixturesPath}...`,
  );

  const engine = new EventDiscoveryIngestionEngine({
    maxQueueSize: config.maxEvents ?? 500,
    maxEvents: config.maxEvents,
    maxTransactions: config.maxTransactions,
  });

  const txMap = new Map<string, VersionedTransactionMetadata>();
  const accountMap = loadAccountMapFromFixtures(config.replayFixturesPath);

  let eventsEnqueued = 0;
  const maxEventsCeiling = config.maxEvents ?? Infinity;

  for (const filePath of fixtureFiles) {
    if (eventsEnqueued >= maxEventsCeiling) {
      logger.info(
        "REPLAY_CEILING",
        `Reached maxEvents ceiling (${maxEventsCeiling}). Halting fixture loading.`,
      );
      break;
    }

    try {
      const raw = fsSync.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.signature && parsed.accountKeys) {
        txMap.set(parsed.signature, parsed);
        const enq = await engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: parsed.slot ?? 300000100 },
              value: {
                signature: parsed.signature,
                err: parsed.err ?? null,
                logs: parsed.logs ?? ["Program log: initialize"],
              },
            },
            subscription: 1,
          },
        });
        if (enq.enqueued) eventsEnqueued++;
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (eventsEnqueued >= maxEventsCeiling) break;
          if (item && typeof item === "object" && item.signature && item.accountKeys) {
            txMap.set(item.signature, item);
            const enq = await engine.handleLogNotification({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                result: {
                  context: { slot: item.slot ?? 300000100 },
                  value: {
                    signature: item.signature,
                    err: item.err ?? null,
                    logs: item.logs ?? ["Program log: initialize"],
                  },
                },
                subscription: 1,
              },
            });
            if (enq.enqueued) eventsEnqueued++;
          }
        }
      }
    } catch (err) {
      logger.warn("REPLAY_PARSE_WARN", `Failed to parse fixture file ${filePath}: ${err}`);
    }
  }

  const txFetcher: ITransactionFetcher = {
    fetchTransaction: async (sig: string) => txMap.get(sig) ?? null,
  };

  let maxSlotSeen = 300000100;
  for (const acc of accountMap.values()) {
    if (acc.slot > maxSlotSeen) maxSlotSeen = acc.slot;
  }

  const accountFetcher: IOnChainAccountFetcher = {
    getAccountInfo: async (addr: string) => accountMap.get(addr) ?? null,
    getMultipleAccounts: async (addrs: readonly string[]) =>
      addrs.map((a) => accountMap.get(a) ?? null),
    getSlot: async () => maxSlotSeen,
  };

  const dispatchResults = await engine.processQueue(txFetcher, accountFetcher);
  const metrics = engine.getMetricsSnapshot();

  if (config.captureFixturesDir) {
    fsSync.mkdirSync(config.captureFixturesDir, { recursive: true });
    const dumpPath = path.join(config.captureFixturesDir, `replayed-metrics-${Date.now()}.json`);
    fsSync.writeFileSync(dumpPath, JSON.stringify(metrics, null, 2), "utf8");
    logger.info("CAPTURE_FIXTURES", `Wrote captured replay telemetry to ${dumpPath}`);
  }

  return {
    ok: true,
    metrics,
    poolsVerified: dispatchResults.filter((r) => r.verified).length,
  };
}

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

  // D.2.9-B Authorization Guard: Reject live WebSocket event capture unless explicitly authorized in Gate 2.9-B (BREADY-05)
  if (config.network === "enabled" && config.discoverySource === "events") {
    console.error(
      "[UNAUTHORIZED_LIVE_EVENTS] Live WebSocket event capture is unauthorized until Phase 12.94-D.2.9-B is formally approved. Use --replay-fixtures=<path> for offline event discovery verification.",
    );
    return 1;
  }

  // Offline Replay Mode or Offline Verification with Replay Fixtures (D29-H3 / BREADY-05): Does not require network authorization
  if (config.replayFixturesPath) {
    const logger = config.logger ?? new PilotLogger({ logFilePath: config.logFilePath });

    // Offline CPMM verification from replay fixtures
    if (config.verifyCpmmPoolAddress) {
      logger.info(
        "VERIFY_CPMM_POOL_START",
        `Initiating offline on-chain verification for Raydium CPMM pool ${config.verifyCpmmPoolAddress} using fixtures from ${config.replayFixturesPath} (replayMode: ${config.replayMode ?? "synthetic"})...`,
      );
      try {
        const offlineTransport =
          config.rpcTransport ??
          createOfflineRpcTransportFromFixtures(config.replayFixturesPath, {
            replayMode: config.replayMode,
          });
        const rpcClient = new SolanaRpcLiveObservationClient({
          rpcUrl: "http://offline-fixtures",
          transport: offlineTransport,
          maxRequestsBudget: config.rpcMaxCalls ?? 2,
          httpTimeoutMs: config.rpcTimeoutMs ?? 10_000,
          commitment: "confirmed",
          onLog: (msg) => logger.info("SOLANA_RPC", msg),
        });

        const report = await rpcClient.verifyCpmmPoolAccount(config.verifyCpmmPoolAddress);
        console.log(
          JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
        );
        return report.verified ? 0 : 1;
      } catch (err) {
        logger.error("REPLAY_ERROR", `Failed offline CPMM verification: ${err}`);
        console.error(`[STRICT_REPLAY_FAILED] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // Offline AMM v4 verification from replay fixtures
    if (config.verifyPoolAddress) {
      logger.info(
        "VERIFY_POOL_START",
        `Initiating offline on-chain verification for Raydium AMM v4 pool ${config.verifyPoolAddress} using fixtures from ${config.replayFixturesPath}...`,
      );
      const offlineTransport =
        config.rpcTransport ?? createOfflineRpcTransportFromFixtures(config.replayFixturesPath);
      const rpcClient = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://offline-fixtures",
        transport: offlineTransport,
        onLog: (msg) => logger.info("SOLANA_RPC", msg),
      });

      const report = await rpcClient.verifyPoolAccount(config.verifyPoolAddress);
      console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return report.verified ? 0 : 1;
    }

    try {
      const report = await runReplaySession(config, logger);
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    } catch (err) {
      logger.error("REPLAY_ERROR", `Failed to replay fixtures: ${err}`);
      return 1;
    }
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

  // Independent On-Chain Raydium CPMM Pool Verification Diagnostic Mode (D29-H3 / B1-PREP-01 / B1-PREP-03)
  if (config.verifyCpmmPoolAddress) {
    const logger = config.logger ?? new PilotLogger({ logFilePath: config.logFilePath });
    logger.info(
      "VERIFY_CPMM_POOL_START",
      `Initiating independent on-chain verification for Raydium CPMM pool ${config.verifyCpmmPoolAddress}...`,
    );
    const rpcClient = new SolanaRpcLiveObservationClient({
      rpcUrl: config.rpcUrl,
      transport: config.rpcTransport,
      maxRequestsBudget: config.rpcMaxCalls ?? 2,
      httpTimeoutMs: config.rpcTimeoutMs ?? 10_000,
      commitment: "confirmed",
      onLog: (msg) => logger.info("SOLANA_RPC", msg),
    });

    const report = await rpcClient.verifyCpmmPoolAccount(config.verifyCpmmPoolAddress);
    console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

    if (config.captureFixturesDir) {
      const snapshot = saveCpmmSnapshot(
        config.captureFixturesDir,
        config.verifyCpmmPoolAddress,
        report,
        logger,
      );
      logger.info(
        "CPMM_SNAPSHOT_SUMMARY",
        `Snapshot [${snapshot.status}] sealed at ${snapshot.snapshotDir} (manifest: ${snapshot.manifestPath})`,
      );
    }

    if (report.verified) {
      logger.info(
        "VERIFY_CPMM_POOL_SUCCESS",
        `Pool ${config.verifyCpmmPoolAddress} verified as canonical Raydium CPMM (tier: ${report.verificationTier}).`,
      );
      return 0;
    } else {
      logger.warn(
        "VERIFY_CPMM_POOL_FAILED",
        `Pool ${config.verifyCpmmPoolAddress} verification failed: ${report.verificationStatus} (${report.error ?? "Verification error"})`,
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
