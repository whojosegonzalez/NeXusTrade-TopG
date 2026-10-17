/**
 * Phase 12.94-D Milestone D.2.4: Forward Outcome Observation Tracker
 *
 * Implements a bounded, timestamped forward-observation mechanism for empirical
 * Solana research. Measures post-decision token outcomes (e.g. price path, liquidity changes,
 * or pool disappearance/rugs) at scheduled forward intervals (+1m, +5m, +15m).
 *
 * Integrity & Causality:
 * - Forward outcome records are stored in a dedicated stream: 'forward-observations.jsonl'.
 * - Baseline decision-time features and market observations are never mutated or backfilled.
 * - Truthfully tracks pool closures, balance drains, and RPC unreachability.
 */

import fsSync from "node:fs";
import path from "node:path";
import type { D23ScreenedCandidate, D23ObservationRecord } from "./PilotTypes.js";
import type { SolanaRpcLiveObservationClient } from "./SolanaRpcLiveObservationClient.js";

export const DEFAULT_FORWARD_INTERVALS_SEC = [60, 300, 900] as const; // 1m, 5m, 15m

export interface ForwardOutcomeObservationRecord {
  readonly forwardObservationId: string;
  readonly baselineDecisionEventId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly targetIntervalSec: number;
  readonly scheduledDueEpochMs: number;
  readonly actualObservationEpochMs: number;
  readonly elapsedSinceDecisionMs: number;
  readonly isPoolActive: boolean;
  readonly spotPriceSol: number | null;
  readonly baseReserveDecimal: number | null;
  readonly quoteReserveDecimal: number | null;
  readonly observationStatus: "OBSERVED_ACTIVE" | "POOL_DRAINED_OR_CLOSED" | "RPC_UNAVAILABLE";
}

interface PendingForwardTarget {
  readonly candidate: D23ScreenedCandidate;
  readonly baselineObservation: D23ObservationRecord;
  readonly targetIntervalSec: number;
  readonly scheduledDueEpochMs: number;
}

export class ForwardOutcomeObservationTracker {
  private readonly sessionDir: string;
  private readonly forwardFilePath: string;
  private readonly pendingTargets: PendingForwardTarget[] = [];
  private readonly targetIntervalsSec: readonly number[];
  private readonly maxPendingTargets: number;

  private totalForwardObservationsRecorded = 0;

  constructor(options: {
    sessionDir: string;
    targetIntervalsSec?: readonly number[] | undefined;
    maxPendingTargets?: number | undefined;
  }) {
    this.sessionDir = options.sessionDir;
    this.forwardFilePath = path.join(this.sessionDir, "forward-observations.jsonl");
    this.targetIntervalsSec = options.targetIntervalsSec ?? DEFAULT_FORWARD_INTERVALS_SEC;
    this.maxPendingTargets = options.maxPendingTargets ?? 150;
  }

  public getPendingTargetsCount(): number {
    return this.pendingTargets.length;
  }

  public getTotalRecordedCount(): number {
    return this.totalForwardObservationsRecorded;
  }

  /**
   * Schedules follow-up observation intervals for a newly screened candidate.
   */
  public registerCandidateForForwardObservation(
    candidate: D23ScreenedCandidate,
    baselineObservation: D23ObservationRecord,
  ): void {
    if (
      !candidate.passedEligibility ||
      candidate.compositeId.poolId === "UNRESOLVED_POOL_ADDRESS"
    ) {
      return;
    }

    const decisionTime = candidate.decisionEpochMs;

    for (const intervalSec of this.targetIntervalsSec) {
      if (this.pendingTargets.length >= this.maxPendingTargets) {
        break; // Bounded ceiling to prevent memory buildup
      }

      this.pendingTargets.push({
        candidate,
        baselineObservation,
        targetIntervalSec: intervalSec,
        scheduledDueEpochMs: decisionTime + intervalSec * 1000,
      });
    }

    // Sort by due epoch ms ascending
    this.pendingTargets.sort((a, b) => a.scheduledDueEpochMs - b.scheduledDueEpochMs);
  }

  /**
   * Polls and executes any forward observations whose scheduled due time has arrived.
   */
  public async pollDueObservations(
    rpcClient: SolanaRpcLiveObservationClient,
    currentEpochMs: number = Date.now(),
  ): Promise<number> {
    const dueIndices: number[] = [];
    for (let i = 0; i < this.pendingTargets.length; i++) {
      const target = this.pendingTargets[i]!;
      if (currentEpochMs >= target.scheduledDueEpochMs) {
        dueIndices.push(i);
      } else {
        break; // sorted ascending
      }
    }

    if (dueIndices.length === 0) {
      return 0;
    }

    let processedCount = 0;
    // Process due targets (slice from front)
    const targetsToProcess = this.pendingTargets.splice(0, dueIndices.length);

    for (const target of targetsToProcess) {
      const { candidate, baselineObservation, targetIntervalSec, scheduledDueEpochMs } = target;
      const observationTime = Date.now();
      const elapsedSinceDecisionMs = observationTime - candidate.decisionEpochMs;

      let record: ForwardOutcomeObservationRecord;

      try {
        const poolResult = await rpcClient.observeRaydiumPool({
          poolAddress: candidate.compositeId.poolId,
          targetMint: candidate.compositeId.mintAddress,
          flowMetrics: baselineObservation.flowMetrics,
          compositeId: {
            ...candidate.compositeId,
            decisionEventId: `fwd-${candidate.compositeId.decisionEventId}-${targetIntervalSec}s`,
          },
        });

        if (poolResult.ok && poolResult.reserveAccounting) {
          record = {
            forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${observationTime}`,
            baselineDecisionEventId: candidate.compositeId.decisionEventId,
            sessionId: candidate.compositeId.sessionId,
            generationId: candidate.compositeId.generationId,
            mintAddress: candidate.compositeId.mintAddress,
            poolId: candidate.compositeId.poolId,
            targetIntervalSec,
            scheduledDueEpochMs,
            actualObservationEpochMs: observationTime,
            elapsedSinceDecisionMs,
            isPoolActive: poolResult.reserveAccounting.effectiveReservesAvailable,
            spotPriceSol: poolResult.reserveAccounting.spotPriceSol,
            baseReserveDecimal: poolResult.reserveAccounting.tokenReserveDecimal,
            quoteReserveDecimal: poolResult.reserveAccounting.solReserveDecimal,
            observationStatus: "OBSERVED_ACTIVE",
          };
        } else {
          // Account closed, non-existent, or invalid
          record = {
            forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${observationTime}`,
            baselineDecisionEventId: candidate.compositeId.decisionEventId,
            sessionId: candidate.compositeId.sessionId,
            generationId: candidate.compositeId.generationId,
            mintAddress: candidate.compositeId.mintAddress,
            poolId: candidate.compositeId.poolId,
            targetIntervalSec,
            scheduledDueEpochMs,
            actualObservationEpochMs: observationTime,
            elapsedSinceDecisionMs,
            isPoolActive: false,
            spotPriceSol: null,
            baseReserveDecimal: null,
            quoteReserveDecimal: null,
            observationStatus: "POOL_DRAINED_OR_CLOSED",
          };
        }
      } catch {
        record = {
          forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${observationTime}`,
          baselineDecisionEventId: candidate.compositeId.decisionEventId,
          sessionId: candidate.compositeId.sessionId,
          generationId: candidate.compositeId.generationId,
          mintAddress: candidate.compositeId.mintAddress,
          poolId: candidate.compositeId.poolId,
          targetIntervalSec,
          scheduledDueEpochMs,
          actualObservationEpochMs: observationTime,
          elapsedSinceDecisionMs,
          isPoolActive: false,
          spotPriceSol: null,
          baseReserveDecimal: null,
          quoteReserveDecimal: null,
          observationStatus: "RPC_UNAVAILABLE",
        };
      }

      this.appendRecord(record);
      processedCount++;
    }

    return processedCount;
  }

  private appendRecord(record: ForwardOutcomeObservationRecord): void {
    const line = JSON.stringify(record) + "\n";
    fsSync.appendFileSync(this.forwardFilePath, line, "utf8");
    this.totalForwardObservationsRecorded++;
  }
}
