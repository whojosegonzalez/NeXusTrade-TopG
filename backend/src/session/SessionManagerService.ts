import type { TerminationReason } from "../db/schema/index.js";
import type { Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { EquityCalculationResult } from "./EquityCalculationService.js";
import { EquityCalculationService } from "./EquityCalculationService.js";
import type { DrawdownEvaluation } from "./DrawdownTrackingService.js";
import { DrawdownTrackingService } from "./DrawdownTrackingService.js";
import type {
  PositionValuationResult,
  PositionValuationService,
} from "./PositionValuationService.js";
import type { SessionCandidateSelector } from "./SessionCandidateSelector.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";
import { SnapshotService, type SnapshotWriteResult } from "./SnapshotService.js";
import type { TargetEvaluation } from "./TargetTrackingService.js";
import { TargetTrackingService } from "./TargetTrackingService.js";

export interface SessionManagerSummary {
  readonly sessionId: string;
  readonly openPositionCount: number;
  readonly positionSnapshotCount: number;
  readonly equitySnapshotCreated: boolean;
  readonly cashLamports: number;
  readonly openPositionValueLamports: number;
  readonly totalEquityLamports: number;
  readonly realizedPnlLamports: number;
  readonly unrealizedPnlLamports: number;
  readonly drawdownLamports: number;
  readonly peakEquityLamports: number;
  readonly terminationReasonBefore: TerminationReason;
  readonly terminationReasonAfter: TerminationReason;
  readonly buyGated: boolean;
  readonly targetReached: boolean;
  readonly drawdownReached: boolean;
  readonly valuationUnavailableCount: number;
  readonly dryRun: boolean;
  readonly target?: TargetEvaluation;
  readonly drawdown: DrawdownEvaluation;
}

export interface SessionManagerServiceOptions {
  readonly config: SessionManagerRuntimeConfig;
  readonly repositories: Repositories;
  readonly selector: SessionCandidateSelector;
  readonly valuationService: PositionValuationService;
  readonly equityCalculationService?: EquityCalculationService;
  readonly targetTrackingService?: TargetTrackingService;
  readonly drawdownTrackingService?: DrawdownTrackingService;
  readonly snapshotService?: SnapshotService;
  readonly clock?: () => number;
}

export class SessionManagerService {
  private readonly equityCalculationService: EquityCalculationService;
  private readonly targetTrackingService: TargetTrackingService;
  private readonly drawdownTrackingService: DrawdownTrackingService;
  private readonly snapshotService: SnapshotService;
  private readonly clock: () => number;

  constructor(private readonly options: SessionManagerServiceOptions) {
    this.equityCalculationService =
      options.equityCalculationService ?? new EquityCalculationService();
    this.targetTrackingService = options.targetTrackingService ?? new TargetTrackingService();
    this.drawdownTrackingService = options.drawdownTrackingService ?? new DrawdownTrackingService();
    this.snapshotService =
      options.snapshotService ?? new SnapshotService({ snapshots: options.repositories.snapshots });
    this.clock = options.clock ?? nowMs;
  }

  async runOnce(): Promise<SessionManagerSummary> {
    const timestampMs = this.clock();
    const session = this.options.selector.selectSession(this.options.config);
    const openPositions = this.options.repositories.positions.listOpenPositions(session.id);

    this.writeLog(session.id, "SessionManager started.", {
      dryRun: this.options.config.dryRun,
      openPositionCount: openPositions.length,
      terminationReason: session.terminationReason,
    });

    const valuations: PositionValuationResult[] = [];

    for (const position of openPositions) {
      const tokenRadar = this.options.repositories.tokenRadar.findRadarEntryByMint(
        session.id,
        position.mintAddress,
      );
      const valuation = await this.options.valuationService.valuePosition({
        position,
        ...(tokenRadar ? { tokenRadar } : {}),
        config: this.options.config,
        nowMs: timestampMs,
      });

      valuations.push(valuation);

      if (valuation.warnings.length > 0) {
        this.writeLog(
          session.id,
          "SessionManager position valuation warnings.",
          {
            positionId: position.id,
            mintAddress: position.mintAddress,
            valuationSource: valuation.valuationSource,
            warnings: valuation.warnings,
          },
          "WARN",
        );
      }
    }

    const equity = this.equityCalculationService.calculate(session, valuations);
    const peakEquitySnapshot = this.options.repositories.snapshots.getPeakEquitySnapshot(
      session.id,
    );
    const target = this.targetTrackingService.evaluate(
      session,
      this.options.config,
      equity.totalEquityLamports,
    );
    const drawdown = this.drawdownTrackingService.evaluate({
      session,
      config: this.options.config,
      totalEquityLamports: equity.totalEquityLamports,
      ...(peakEquitySnapshot ? { peakEquitySnapshot } : {}),
    });
    const terminationReasonAfter = resolveTerminationReason({
      current: session.terminationReason,
      targetReached: target.reached,
      drawdownReached: drawdown.reached,
    });
    const snapshots = this.snapshotService.createSnapshots({
      sessionId: session.id,
      timestampMs,
      equity,
      drawdown,
      dryRun: this.options.config.dryRun,
    });

    if (!this.options.config.dryRun) {
      this.options.repositories.sessions.updateSessionGovernance(session.id, {
        unrealizedPnlLamports: equity.unrealizedPnlLamports,
        ...(terminationReasonAfter !== session.terminationReason
          ? { terminationReason: terminationReasonAfter }
          : {}),
      });
    }

    if (terminationReasonAfter !== session.terminationReason) {
      this.writeLog(session.id, "SessionManager BUY gate activated.", {
        terminationReasonBefore: session.terminationReason,
        terminationReasonAfter,
        totalEquityLamports: equity.totalEquityLamports,
        drawdownLamports: drawdown.drawdownLamports,
        dryRun: this.options.config.dryRun,
      });
    }

    const summary = createSummary({
      sessionId: session.id,
      equity,
      target,
      drawdown,
      snapshots,
      openPositionCount: openPositions.length,
      terminationReasonBefore: session.terminationReason,
      terminationReasonAfter,
      dryRun: this.options.config.dryRun,
      valuationUnavailableCount: valuations.filter((valuation) => valuation.valuationUnavailable)
        .length,
    });

    this.writeLog(session.id, "SessionManager summary.", summary);

    return summary;
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
      scope: "SESSION",
      message,
      contextJson: stringifyJson(context),
    });
  }
}

function resolveTerminationReason(input: {
  readonly current: TerminationReason;
  readonly targetReached: boolean;
  readonly drawdownReached: boolean;
}): TerminationReason {
  if (input.current !== "NOT_TERMINATED") {
    return input.current;
  }

  if (input.drawdownReached) {
    return "MAX_DRAWDOWN";
  }

  if (input.targetReached) {
    return "TARGET_REACHED";
  }

  return "NOT_TERMINATED";
}

function createSummary(input: {
  readonly sessionId: string;
  readonly equity: EquityCalculationResult;
  readonly target: TargetEvaluation;
  readonly drawdown: DrawdownEvaluation;
  readonly snapshots: SnapshotWriteResult;
  readonly openPositionCount: number;
  readonly terminationReasonBefore: TerminationReason;
  readonly terminationReasonAfter: TerminationReason;
  readonly valuationUnavailableCount: number;
  readonly dryRun: boolean;
}): SessionManagerSummary {
  return {
    sessionId: input.sessionId,
    openPositionCount: input.openPositionCount,
    positionSnapshotCount: input.snapshots.positionSnapshotCount,
    equitySnapshotCreated: input.snapshots.equitySnapshotCreated,
    cashLamports: input.equity.cashLamports,
    openPositionValueLamports: input.equity.openPositionValueLamports,
    totalEquityLamports: input.equity.totalEquityLamports,
    realizedPnlLamports: input.equity.realizedPnlLamports,
    unrealizedPnlLamports: input.equity.unrealizedPnlLamports,
    drawdownLamports: input.drawdown.drawdownLamports,
    peakEquityLamports: input.drawdown.peakEquityLamports,
    terminationReasonBefore: input.terminationReasonBefore,
    terminationReasonAfter: input.terminationReasonAfter,
    buyGated: input.terminationReasonAfter !== "NOT_TERMINATED",
    targetReached: input.target.reached,
    drawdownReached: input.drawdown.reached,
    valuationUnavailableCount: input.valuationUnavailableCount,
    dryRun: input.dryRun,
    target: input.target,
    drawdown: input.drawdown,
  };
}
