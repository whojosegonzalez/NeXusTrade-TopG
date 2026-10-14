import crypto from "node:crypto";
import type {
  CandidateDecisionRecord,
  CandidateMetricsSnapshot,
  DecisionCohort,
  FilterEvaluationDetail,
} from "./TelemetryTypes.js";
import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";
import { resolveStrategyRevision } from "./RevisionHelper.js";

export interface RecordDecisionInput {
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly poolOpenTimeMs?: number | undefined;
  readonly decisionCohort: DecisionCohort;
  readonly primaryRejectionReason?: string | undefined;
  readonly filterEvaluations: readonly FilterEvaluationDetail[];
  readonly metricsSnapshot: CandidateMetricsSnapshot;
  readonly missingFields?: readonly string[] | undefined;
  readonly providerIdentity: string;
}

export class CandidateDecisionRecorder {
  private readonly storage: TelemetryStorageManager;
  private readonly countsByCohort = new Map<DecisionCohort, number>();
  private readonly countsByReason = new Map<string, number>();

  constructor(storage: TelemetryStorageManager) {
    this.storage = storage;
  }

  public recordDecision(input: RecordDecisionInput): CandidateDecisionRecord {
    const decisionTimestampMs = Date.now();
    const eventId = crypto.randomUUID();

    const record: CandidateDecisionRecord = {
      eventId,
      sessionId: input.sessionId,
      generationId: input.generationId,
      mintAddress: input.mintAddress,
      poolId: input.poolId,
      symbol: input.symbol,
      sourceTimestampMs: input.sourceTimestampMs,
      ingestionTimestampMs: input.ingestionTimestampMs,
      decisionTimestampMs,
      poolOpenTimeMs: input.poolOpenTimeMs,
      strategyRevision: resolveStrategyRevision(),
      decisionCohort: input.decisionCohort,
      primaryRejectionReason: input.primaryRejectionReason,
      filterEvaluations: input.filterEvaluations,
      metricsSnapshot: input.metricsSnapshot,
      missingFields: input.missingFields ?? [],
      providerIdentity: input.providerIdentity,
    };

    this.storage.appendCandidateDecision(record);

    // Track statistics
    const currentCohortCount = this.countsByCohort.get(input.decisionCohort) ?? 0;
    this.countsByCohort.set(input.decisionCohort, currentCohortCount + 1);

    if (input.primaryRejectionReason) {
      const currentReasonCount = this.countsByReason.get(input.primaryRejectionReason) ?? 0;
      this.countsByReason.set(input.primaryRejectionReason, currentReasonCount + 1);
    }

    return record;
  }

  public syncFromStorage(sessionId: string): void {
    const records = this.storage.readCandidateDecisions(sessionId);
    this.countsByCohort.clear();
    this.countsByReason.clear();
    for (const rec of records) {
      this.countsByCohort.set(
        rec.decisionCohort,
        (this.countsByCohort.get(rec.decisionCohort) ?? 0) + 1,
      );
      if (rec.primaryRejectionReason) {
        this.countsByReason.set(
          rec.primaryRejectionReason,
          (this.countsByReason.get(rec.primaryRejectionReason) ?? 0) + 1,
        );
      }
    }
  }

  public getScannerDecisionsCount(): number {
    return (
      (this.countsByCohort.get("FILTERED_REJECTED") ?? 0) +
      (this.countsByCohort.get("WATCHLIST_RADAR") ?? 0)
    );
  }

  public getTriggerDecisionsCount(): number {
    return this.countsByCohort.get("TRIGGER_REJECTED") ?? 0;
  }

  public getExecutedBuyDecisionsCount(): number {
    return this.countsByCohort.get("EXECUTED_BUY") ?? 0;
  }

  public getCohortCount(cohort: DecisionCohort): number {
    return this.countsByCohort.get(cohort) ?? 0;
  }

  public getTotalDecisionsCount(): number {
    let total = 0;
    for (const v of this.countsByCohort.values()) {
      total += v;
    }
    return total;
  }

  public getCohortBreakdown(): Record<DecisionCohort, number> {
    return {
      FILTERED_REJECTED: this.countsByCohort.get("FILTERED_REJECTED") ?? 0,
      WATCHLIST_RADAR: this.countsByCohort.get("WATCHLIST_RADAR") ?? 0,
      TRIGGER_REJECTED: this.countsByCohort.get("TRIGGER_REJECTED") ?? 0,
      EXECUTED_BUY: this.countsByCohort.get("EXECUTED_BUY") ?? 0,
    };
  }

  public getRejectionReasonBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.countsByReason.entries()) {
      out[k] = v;
    }
    return out;
  }
}
