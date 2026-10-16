/**
 * Phase 12.94-D Milestone D.2.3: Pilot Collector Runner
 *
 * Implements bounded, read-only collection state machine for the empirical pilot.
 * Enforces canonical statuses (ACTIVE, FINALIZED, INTERRUPTED), isolated path confinement,
 * resource ceilings (20MB disk, 256MB RSS), dual-file consensus, and crash recovery.
 *
 * NOTE: Network access is strictly disabled. In this implementation round, data is
 * supplied via offline mock transports and synthetic fixtures.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SystemPilotClock, type IPilotClock } from "./PilotClock.js";
import {
  toCanonicalCandidateDecision,
  toCanonicalMarketObservation,
  toCanonicalShadowEvaluation,
} from "./PilotSchemaBridge.js";
import { generateSessionExportManifest } from "./PilotExportManifest.js";
import type {
  CanonicalSessionStatus,
  D23ObservationRecord,
  D23ScreenedCandidate,
  PilotCollectorConfig,
} from "./PilotTypes.js";
import type {
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";

export interface MockPilotDataSource {
  fetchLatestProfiles(): Promise<unknown>;
  fetchTokenPairs(tokenAddress: string): Promise<unknown>;
  fetchPoolAccountInfo(poolAddress: string): Promise<unknown>;
  fetchVaultBalances(vaultAddresses: readonly [string, string]): Promise<unknown>;
}

export interface ResolvedPilotConfig {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly outputRootDir: string;
  readonly targetCandidates: number;
  readonly targetPools: number;
  readonly maxDurationSec: number;
  readonly maxDiskBytes: number;
  readonly maxRssBytes: number;
  readonly maxConsecutiveErrors: number;
  readonly candidatePollIntervalMs: number;
}

export class PilotCollectorRunner {
  private readonly config: ResolvedPilotConfig;
  private readonly sessionDir: string;
  private readonly clock: IPilotClock;
  private readonly dataSource?: MockPilotDataSource | undefined;

  private status: CanonicalSessionStatus = "ACTIVE";
  private startEpochMs: number = 0;
  private bytesWritten: number = 0;
  private consecutiveErrors: number = 0;

  private totalCandidatesScreened: number = 0;
  private totalWatchlistRadar: number = 0;
  private totalFilteredRejected: number = 0;
  private totalEvaluationsRecorded: number = 0;
  private totalObservationsRecorded: number = 0;
  private readonly uniquePoolsSeen = new Set<string>();
  private interruptionReason?: string | undefined;

  constructor(
    config: PilotCollectorConfig,
    dataSource?: MockPilotDataSource | undefined,
    clock: IPilotClock = new SystemPilotClock(),
  ) {
    this.config = {
      sessionId: config.sessionId,
      generationId: config.generationId,
      strategyRevision: config.strategyRevision,
      outputRootDir: config.outputRootDir,
      targetCandidates: config.targetCandidates ?? 100,
      targetPools: config.targetPools ?? 20,
      maxDurationSec: config.maxDurationSec ?? 7200,
      maxDiskBytes: config.maxDiskBytes ?? 20 * 1024 * 1024, // 20 MB
      maxRssBytes: config.maxRssBytes ?? 256 * 1024 * 1024, // 256 MB
      maxConsecutiveErrors: config.maxConsecutiveErrors ?? 5,
      candidatePollIntervalMs: config.candidatePollIntervalMs ?? 60_000,
    };

    this.dataSource = dataSource;
    this.clock = clock;
    this.sessionDir = path.resolve(this.config.outputRootDir, this.config.sessionId);
    this.validatePathConfinement(this.sessionDir);
  }

  private validatePathConfinement(targetPath: string): void {
    const normalized = path.resolve(targetPath);
    // Path must not resolve into protected repository roots
    const forbiddenPatterns = [
      /[\\/]backend[\\/]src/,
      /[\\/]shared[\\/]src/,
      /[\\/]frontend[\\/]src/,
      /[\\/]\.tmp[\\/]telemetry/,
      /[\\/]\.tmp[\\/]sessions/,
    ];
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(normalized)) {
        throw new Error(
          `PATH_CONFINEMENT_VIOLATION: Output directory ${normalized} is inside protected area`,
        );
      }
    }
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    this.startEpochMs = this.clock.getEpochNow();
    this.status = "ACTIVE";

    const meta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      sessionStatus: "ACTIVE",
      isInterruptedSession: false,
      resumedFromPriorCrash: false,
    };

    await this.writeSessionMeta(meta);
  }

  public async recordScreenedCandidate(
    candidate: D23ScreenedCandidate,
    observation?: D23ObservationRecord | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE") {
      throw new Error(`Cannot record candidate in session state ${this.status}`);
    }

    this.checkResourceLimits();

    const canonicalCandidate = toCanonicalCandidateDecision(candidate, observation);
    const candidateLine = JSON.stringify(canonicalCandidate) + "\n";
    await this.appendFile("candidate-decisions.jsonl", candidateLine);
    this.totalCandidatesScreened += 1;

    if (candidate.decisionCohort === "WATCHLIST_RADAR") {
      this.totalWatchlistRadar += 1;
    } else {
      this.totalFilteredRejected += 1;
    }

    if (candidate.compositeId.poolId) {
      this.uniquePoolsSeen.add(candidate.compositeId.poolId);
    }

    // Record 1:1 Shadow Evaluation Record
    const canonicalEvaluation = toCanonicalShadowEvaluation(candidate, observation);
    const evalLine = JSON.stringify(canonicalEvaluation) + "\n";
    await this.appendFile("shadow-evaluations.jsonl", evalLine);
    this.totalEvaluationsRecorded += 1;

    // Record Market Observation Record if present
    if (observation) {
      const canonicalObs = toCanonicalMarketObservation(observation, this.config.strategyRevision);
      const obsLine = JSON.stringify(canonicalObs) + "\n";
      await this.appendFile("market-observations.jsonl", obsLine);
      this.totalObservationsRecorded += 1;
    }

    this.consecutiveErrors = 0;

    // Check target stopping conditions
    if (
      this.totalCandidatesScreened >= this.config.targetCandidates &&
      this.uniquePoolsSeen.size >= this.config.targetPools
    ) {
      await this.finalize("FINALIZED");
    }
  }

  public async recordError(error: Error | string): Promise<void> {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      await this.finalize("INTERRUPTED", `EXCEEDED_MAX_CONSECUTIVE_ERRORS: ${String(error)}`);
    }
  }

  private checkResourceLimits(): void {
    if (this.bytesWritten >= this.config.maxDiskBytes) {
      throw new Error(`DISK_QUOTA_EXCEEDED: ${this.bytesWritten} >= ${this.config.maxDiskBytes}`);
    }

    const memoryUsage = process.memoryUsage();
    if (memoryUsage.rss >= this.config.maxRssBytes) {
      throw new Error(
        `MEMORY_RSS_CEILING_EXCEEDED: ${memoryUsage.rss} >= ${this.config.maxRssBytes}`,
      );
    }

    const elapsedSec = (this.clock.getEpochNow() - this.startEpochMs) / 1000;
    if (elapsedSec >= this.config.maxDurationSec) {
      throw new Error(`DURATION_BOX_EXPIRED: ${elapsedSec}s >= ${this.config.maxDurationSec}s`);
    }
  }

  public async finalize(
    targetStatus: "FINALIZED" | "INTERRUPTED",
    interruptionReason?: string | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE") {
      return;
    }

    this.status = targetStatus;
    this.interruptionReason = interruptionReason;
    const endEpochMs = this.clock.getEpochNow();

    const meta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      sessionStatus: targetStatus,
      isInterruptedSession: targetStatus === "INTERRUPTED",
      resumedFromPriorCrash: false,
    };

    await this.writeSessionMeta(meta);

    const summary: SessionTelemetrySummary = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      totalCandidatesScreened: this.totalCandidatesScreened,
      totalDecisionsRecorded: this.totalCandidatesScreened,
      decisionWriteFailures: 0,
      cohortBreakdown: {
        filteredRejected: this.totalFilteredRejected,
        watchlistRadar: this.totalWatchlistRadar,
        triggerRejected: 0,
        executedBuy: 0,
      },
      topRejectionReasons: {},
      totalMarketObservationsRecorded: this.totalObservationsRecorded,
      totalStratifiedCandidatesTracked: 0,
      missedWinnersCount: 0,
      avoidedRugsCount: 0,
      isCompleteSession: targetStatus === "FINALIZED",
      isInterruptedSession: targetStatus === "INTERRUPTED",
    };

    await this.writeSessionSummary(summary);
    await generateSessionExportManifest(
      this.sessionDir,
      this.config.sessionId,
      this.config.generationId,
      endEpochMs,
    );
  }

  public static async recoverSession(sessionDir: string): Promise<{
    recovered: boolean;
    status: CanonicalSessionStatus;
    tornLinesIsolated: number;
    diagnostics: string[];
  }> {
    const diagnostics: string[] = [];
    let tornLinesIsolated = 0;

    const metaPath = path.join(sessionDir, "session-meta.json");
    let meta: SessionTelemetryMeta | null = null;

    try {
      const content = await fs.readFile(metaPath, "utf8");
      meta = JSON.parse(content) as SessionTelemetryMeta;
    } catch (err) {
      diagnostics.push(`Missing or unreadable session-meta.json: ${String(err)}`);
    }

    // Clean any torn lines in jsonl files
    const jsonlFiles = [
      "candidate-decisions.jsonl",
      "shadow-evaluations.jsonl",
      "market-observations.jsonl",
    ];
    for (const file of jsonlFiles) {
      const filePath = path.join(sessionDir, file);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n");
        const validLines: string[] = [];
        const corruptLines: string[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line);
            validLines.push(line);
          } catch {
            corruptLines.push(line);
          }
        }

        if (corruptLines.length > 0) {
          tornLinesIsolated += corruptLines.length;
          diagnostics.push(`Isolated ${corruptLines.length} corrupt line(s) in ${file}`);
          await fs.writeFile(
            path.join(sessionDir, `${file}.corrupt-${Date.now()}`),
            corruptLines.join("\n"),
            "utf8",
          );
          await fs.writeFile(filePath, validLines.join("\n") + "\n", "utf8");
        }
      } catch {
        // File might not exist if session crashed before writes
      }
    }

    // If session was not cleanly FINALIZED, force status to INTERRUPTED (D23P-04)
    const currentStatus =
      meta?.sessionStatus ?? (meta as unknown as Record<string, unknown> | null)?.status;

    if (!meta || currentStatus !== "FINALIZED") {
      const repairedMeta: Record<string, unknown> = {
        sessionId: meta?.sessionId ?? path.basename(sessionDir),
        generationId: meta?.generationId ?? "unknown",
        strategyRevision: meta?.strategyRevision ?? "unknown",
        startedAtIso: meta?.startedAtIso ?? new Date().toISOString(),
        closedAtIso: new Date().toISOString(),
        initialWalletBalanceSol: 7.9259,
        environment: meta?.environment ?? {
          platform: process.platform,
          nodeVersion: process.version,
        },
        sessionStatus: "INTERRUPTED",
        status: "INTERRUPTED",
        isInterruptedSession: true,
        resumedFromPriorCrash: true,
        interruptionReason: "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION",
      };
      await fs.writeFile(metaPath, JSON.stringify(repairedMeta, null, 2), "utf8");
      diagnostics.push("Session status marked INTERRUPTED due to unfinalized recovery");
      return {
        recovered: true,
        status: "INTERRUPTED",
        tornLinesIsolated,
        diagnostics,
      };
    }

    return {
      recovered: true,
      status: (currentStatus ?? "FINALIZED") as CanonicalSessionStatus,
      tornLinesIsolated,
      diagnostics,
    };
  }

  private async appendFile(filename: string, content: string): Promise<void> {
    const filePath = path.join(this.sessionDir, filename);
    const bytes = Buffer.byteLength(content, "utf8");
    await fs.appendFile(filePath, content, "utf8");
    this.bytesWritten += bytes;
  }

  private async writeSessionMeta(meta: SessionTelemetryMeta): Promise<void> {
    const filePath = path.join(this.sessionDir, "session-meta.json");
    const metaPayload: Record<string, unknown> = {
      ...meta,
      status: meta.sessionStatus,
    };
    const content = JSON.stringify(metaPayload, null, 2);
    await fs.writeFile(filePath, content, "utf8");
    this.bytesWritten += Buffer.byteLength(content, "utf8");
  }

  private async writeSessionSummary(summary: SessionTelemetrySummary): Promise<void> {
    const filePath = path.join(this.sessionDir, "session-summary.json");
    const content = JSON.stringify(summary, null, 2);
    await fs.writeFile(filePath, content, "utf8");
    this.bytesWritten += Buffer.byteLength(content, "utf8");
  }

  public getSessionDirectory(): string {
    return this.sessionDir;
  }

  public getStatus(): CanonicalSessionStatus {
    return this.status;
  }

  public getInterruptionReason(): string | undefined {
    return this.interruptionReason;
  }

  public getStats(): {
    candidates: number;
    radar: number;
    rejected: number;
    evaluations: number;
    observations: number;
    pools: number;
    bytesWritten: number;
  } {
    return {
      candidates: this.totalCandidatesScreened,
      radar: this.totalWatchlistRadar,
      rejected: this.totalFilteredRejected,
      evaluations: this.totalEvaluationsRecorded,
      observations: this.totalObservationsRecorded,
      pools: this.uniquePoolsSeen.size,
      bytesWritten: this.bytesWritten,
    };
  }
}
