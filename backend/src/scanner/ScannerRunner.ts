import type { SessionRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { CandidateEnrichmentService } from "./CandidateEnrichmentService.js";
import { createScannerConfigSnapshot, type ScannerRuntimeConfig } from "./ScannerConfig.js";
import { dedupeCandidatesByMint, ScannerDiscoveryService } from "./ScannerDiscoveryService.js";
import { TokenRadarPersistenceService } from "./TokenRadarPersistenceService.js";
import { mapCandidateToRadarEntry } from "./mappers/RadarCandidateMapper.js";

export interface ScannerCycleResult {
  readonly sessionId: string;
  readonly discoveredCount: number;
  readonly uniqueCount: number;
  readonly duplicateCount: number;
  readonly enrichedCount: number;
  readonly storedCount: number;
  readonly errorCount: number;
  readonly dryRun: boolean;
}

export interface ScannerRunnerOptions {
  readonly config: ScannerRuntimeConfig;
  readonly repositories: Repositories;
  readonly registry: ProviderRegistry;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly clock?: () => number;
}

export class ScannerRunner {
  private stopped = false;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(private readonly options: ScannerRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.clock = options.clock ?? nowMs;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<ScannerCycleResult | undefined> {
    return this.options.config.once ? this.runOnce() : this.runContinuously();
  }

  async runOnce(): Promise<ScannerCycleResult> {
    const session = this.resolveSession();
    return this.runCycle(session.id);
  }

  async runContinuously(): Promise<ScannerCycleResult | undefined> {
    const session = this.resolveSession();
    let lastResult: ScannerCycleResult | undefined;

    this.writeLog(session.id, "Scanner continuous mode started.", {
      intervalMs: this.options.config.intervalMs,
      dryRun: this.options.config.dryRun,
    });

    while (!this.stopped) {
      lastResult = await this.runCycle(session.id);

      if (!this.stopped) {
        await this.sleep(this.options.config.intervalMs);
      }
    }

    this.writeLog(session.id, "Scanner continuous mode stopped.", {
      lastResult,
    });

    return lastResult;
  }

  async runCycle(sessionId: string): Promise<ScannerCycleResult> {
    const cycleTimestampMs = this.clock();

    try {
      this.writeLog(sessionId, "Scanner cycle started.", {
        limit: this.options.config.limit,
        concurrency: this.options.config.concurrency,
        dryRun: this.options.config.dryRun,
      });

      const discovery = await new ScannerDiscoveryService({
        registry: this.options.registry,
        systemLogs: this.options.repositories.systemLogs,
        sessionId,
      }).discover(this.options.config.limit);
      const dedupe = dedupeCandidatesByMint(discovery.candidates);

      this.writeLog(sessionId, "Scanner dedupe completed.", {
        rawCount: dedupe.rawCount,
        uniqueCount: dedupe.uniqueCount,
        duplicateCount: dedupe.duplicateCount,
      });

      const enrichment = await new CandidateEnrichmentService({
        marketDataService: this.options.marketDataService,
        concurrency: this.options.config.concurrency,
      }).enrichCandidates(dedupe.candidates);
      const radarInputs = enrichment.candidates.map((candidate) =>
        mapCandidateToRadarEntry({
          sessionId,
          candidate: candidate.candidate,
          enrichment: candidate.result,
          cycleTimestampMs,
        }),
      );
      const persistence = new TokenRadarPersistenceService({
        repositories: this.options.repositories,
        sessionId,
        dryRun: this.options.config.dryRun,
      }).persist(radarInputs);
      const errorCount =
        discovery.metrics.failedProviderCount + enrichment.failedCount + persistence.errorCount;
      const result: ScannerCycleResult = {
        sessionId,
        discoveredCount: dedupe.rawCount,
        uniqueCount: dedupe.uniqueCount,
        duplicateCount: dedupe.duplicateCount,
        enrichedCount: enrichment.enrichedCount,
        storedCount: persistence.storedCount,
        errorCount,
        dryRun: this.options.config.dryRun,
      };

      this.writeLog(sessionId, "Scanner cycle summary.", {
        discovered: result.discoveredCount,
        unique: result.uniqueCount,
        enriched: result.enrichedCount,
        stored: result.storedCount,
        errors: result.errorCount,
        dryRun: result.dryRun,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scanner cycle failure.";

      this.writeLog(
        sessionId,
        "Scanner cycle failed.",
        {
          error: message,
        },
        "ERROR",
      );

      return {
        sessionId,
        discoveredCount: 0,
        uniqueCount: 0,
        duplicateCount: 0,
        enrichedCount: 0,
        storedCount: 0,
        errorCount: 1,
        dryRun: this.options.config.dryRun,
      };
    }
  }

  resolveSession(): SessionRecord {
    if (this.options.config.sessionId) {
      return this.resolveExistingSession(this.options.config.sessionId);
    }

    const timestamp = this.clock();
    const session = this.options.repositories.sessions.createSession({
      mode: "PAPER",
      status: "RUNNING",
      startedAtMs: timestamp,
      startingBalanceLamports: 0,
      currentCashLamports: 0,
      configSnapshotJson: stringifyJson(createScannerConfigSnapshot(this.options.config)),
    });

    this.writeLog(session.id, "Scanner auto-created PAPER session.", {
      sessionId: session.id,
      config: createScannerConfigSnapshot(this.options.config),
    });

    return session;
  }

  private resolveExistingSession(sessionId: string): SessionRecord {
    const session = this.options.repositories.sessions.getSessionById(sessionId);

    if (!session) {
      throw new Error(`Scanner session not found: ${sessionId}`);
    }

    if (session.mode !== "PAPER") {
      throw new Error(`Scanner session must be PAPER. Session ${sessionId} is ${session.mode}.`);
    }

    if (session.status === "CREATED") {
      return this.options.repositories.sessions.markSessionRunning(session.id);
    }

    if (session.status === "RUNNING") {
      return session;
    }

    if (session.status === "PAUSED") {
      throw new Error(`Scanner session ${sessionId} is PAUSED. PAUSED reuse is deferred.`);
    }

    throw new Error(
      `Scanner session ${sessionId} is not reusable because it is ${session.status}.`,
    );
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    this.options.repositories.systemLogs.createLog({
      sessionId,
      level,
      scope: "SCANNER",
      message,
      contextJson: stringifyJson(context),
    });
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
