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
 * - Truthfully distinguishes pool closures, balance drains, RPC unavailability, and terminal censoring.
 * - Actual observation timestamp is attested AFTER awaiting RPC response.
 */

import fsSync from "node:fs";
import path from "node:path";
import type { D23ScreenedCandidate, D23ObservationRecord } from "./PilotTypes.js";
import type { SolanaRpcLiveObservationClient } from "./SolanaRpcLiveObservationClient.js";

export const DEFAULT_FORWARD_INTERVALS_SEC = [60, 300, 900] as const; // 1m, 5m, 15m

export type ForwardObservationStatus =
  | "OBSERVED_ACTIVE"
  | "POOL_DRAINED"
  | "POOL_CLOSED_CONFIRMED"
  | "UNVERIFIED_ACCOUNT"
  | "RPC_UNAVAILABLE"
  | "WINDOW_TRUNCATED"
  | "CENSORED_TERMINAL_INTERRUPT"
  | "POOL_DRAINED_OR_CLOSED";

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
  readonly observationStatus: ForwardObservationStatus;
  readonly censorReason?: string | undefined;
}

export interface ForwardOutcomeSummary {
  readonly totalScheduled: number;
  readonly totalRecorded: number;
  readonly totalActive: number;
  readonly totalDrained: number;
  readonly totalClosedConfirmed: number;
  readonly totalUnverified: number;
  readonly totalRpcUnavailable: number;
  readonly totalTruncated: number;
  readonly totalCensoredInterrupt: number;
  readonly remainingPending: number;
  readonly byInterval: Record<
    string,
    {
      scheduled: number;
      active: number;
      drained: number;
      closed: number;
      rpcUnavailable: number;
      truncated: number;
      censored: number;
    }
  >;
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
  private readonly summaryFilePath: string;
  private readonly pendingTargets: PendingForwardTarget[] = [];
  private readonly targetIntervalsSec: readonly number[];
  private readonly maxPendingTargets: number;

  private totalScheduled = 0;
  private totalForwardObservationsRecorded = 0;
  private readonly statusCounts: Record<ForwardObservationStatus, number> = {
    OBSERVED_ACTIVE: 0,
    POOL_DRAINED: 0,
    POOL_CLOSED_CONFIRMED: 0,
    UNVERIFIED_ACCOUNT: 0,
    RPC_UNAVAILABLE: 0,
    WINDOW_TRUNCATED: 0,
    CENSORED_TERMINAL_INTERRUPT: 0,
    POOL_DRAINED_OR_CLOSED: 0,
  };
  private readonly intervalStats = new Map<
    number,
    {
      scheduled: number;
      active: number;
      drained: number;
      closed: number;
      rpcUnavailable: number;
      truncated: number;
      censored: number;
    }
  >();

  constructor(options: {
    sessionDir: string;
    targetIntervalsSec?: readonly number[] | undefined;
    maxPendingTargets?: number | undefined;
  }) {
    this.sessionDir = options.sessionDir;
    this.forwardFilePath = path.join(this.sessionDir, "forward-observations.jsonl");
    this.summaryFilePath = path.join(this.sessionDir, "forward-summary.json");
    this.targetIntervalsSec = options.targetIntervalsSec ?? DEFAULT_FORWARD_INTERVALS_SEC;
    this.maxPendingTargets = options.maxPendingTargets ?? 150;

    for (const sec of this.targetIntervalsSec) {
      this.intervalStats.set(sec, {
        scheduled: 0,
        active: 0,
        drained: 0,
        closed: 0,
        rpcUnavailable: 0,
        truncated: 0,
        censored: 0,
      });
    }
  }

  public getPendingTargetsCount(): number {
    return this.pendingTargets.length;
  }

  public getTotalRecordedCount(): number {
    return this.totalForwardObservationsRecorded;
  }

  public getTotalScheduledCount(): number {
    return this.totalScheduled;
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

      this.totalScheduled++;
      const currentStats = this.intervalStats.get(intervalSec);
      if (currentStats) {
        currentStats.scheduled++;
      } else {
        this.intervalStats.set(intervalSec, {
          scheduled: 1,
          active: 0,
          drained: 0,
          closed: 0,
          rpcUnavailable: 0,
          truncated: 0,
          censored: 0,
        });
      }
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
    const targetsToProcess = this.pendingTargets.splice(0, dueIndices.length);

    for (const target of targetsToProcess) {
      const { candidate, baselineObservation, targetIntervalSec, scheduledDueEpochMs } = target;

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

        // D24F-02: Stamp actual observation receipt time AFTER awaiting RPC response
        const actualObservationEpochMs = Date.now();
        const elapsedSinceDecisionMs = actualObservationEpochMs - candidate.decisionEpochMs;

        if (poolResult.ok && poolResult.reserveAccounting) {
          const isDrained =
            poolResult.reserveAccounting.tokenReserveRaw === 0n ||
            poolResult.reserveAccounting.solReserveRaw === 0n;

          if (isDrained) {
            record = {
              forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${actualObservationEpochMs}`,
              baselineDecisionEventId: candidate.compositeId.decisionEventId,
              sessionId: candidate.compositeId.sessionId,
              generationId: candidate.compositeId.generationId,
              mintAddress: candidate.compositeId.mintAddress,
              poolId: candidate.compositeId.poolId,
              targetIntervalSec,
              scheduledDueEpochMs,
              actualObservationEpochMs,
              elapsedSinceDecisionMs,
              isPoolActive: false,
              spotPriceSol: poolResult.reserveAccounting.spotPriceSol,
              baseReserveDecimal: poolResult.reserveAccounting.tokenReserveDecimal,
              quoteReserveDecimal: poolResult.reserveAccounting.solReserveDecimal,
              observationStatus: "POOL_DRAINED",
            };
          } else {
            // D24F-03: Active pool verified on-chain, isPoolActive is true regardless of effectiveReservesAvailable
            record = {
              forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${actualObservationEpochMs}`,
              baselineDecisionEventId: candidate.compositeId.decisionEventId,
              sessionId: candidate.compositeId.sessionId,
              generationId: candidate.compositeId.generationId,
              mintAddress: candidate.compositeId.mintAddress,
              poolId: candidate.compositeId.poolId,
              targetIntervalSec,
              scheduledDueEpochMs,
              actualObservationEpochMs,
              elapsedSinceDecisionMs,
              isPoolActive: true,
              spotPriceSol: poolResult.reserveAccounting.spotPriceSol,
              baseReserveDecimal: poolResult.reserveAccounting.tokenReserveDecimal,
              quoteReserveDecimal: poolResult.reserveAccounting.solReserveDecimal,
              observationStatus: "OBSERVED_ACTIVE",
            };
          }
        } else {
          // D24F-03: Differentiate non-OK RPC results (429/timeout vs null account vs owner mismatch)
          const err = poolResult.error ?? "";
          let status: ForwardObservationStatus = "RPC_UNAVAILABLE";
          if (err.includes("not found on-chain") || err.includes("null value")) {
            status = "POOL_CLOSED_CONFIRMED";
          } else if (
            err.includes("UNAUTHORIZED") ||
            err.includes("parse error") ||
            err.includes("Raydium parse")
          ) {
            status = "UNVERIFIED_ACCOUNT";
          } else if (
            err.includes("THROTTLED") ||
            err.includes("429") ||
            err.includes("RATE_LIMIT") ||
            err.includes("RPC") ||
            err.includes("timeout") ||
            err.includes("abort")
          ) {
            status = "RPC_UNAVAILABLE";
          }

          record = {
            forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${actualObservationEpochMs}`,
            baselineDecisionEventId: candidate.compositeId.decisionEventId,
            sessionId: candidate.compositeId.sessionId,
            generationId: candidate.compositeId.generationId,
            mintAddress: candidate.compositeId.mintAddress,
            poolId: candidate.compositeId.poolId,
            targetIntervalSec,
            scheduledDueEpochMs,
            actualObservationEpochMs,
            elapsedSinceDecisionMs,
            isPoolActive: false,
            spotPriceSol: null,
            baseReserveDecimal: null,
            quoteReserveDecimal: null,
            observationStatus: status,
            censorReason: err || undefined,
          };
        }
      } catch (err) {
        const actualObservationEpochMs = Date.now();
        const elapsedSinceDecisionMs = actualObservationEpochMs - candidate.decisionEpochMs;
        record = {
          forwardObservationId: `fwd-obs-${candidate.compositeId.mintAddress.slice(0, 8)}-${targetIntervalSec}s-${actualObservationEpochMs}`,
          baselineDecisionEventId: candidate.compositeId.decisionEventId,
          sessionId: candidate.compositeId.sessionId,
          generationId: candidate.compositeId.generationId,
          mintAddress: candidate.compositeId.mintAddress,
          poolId: candidate.compositeId.poolId,
          targetIntervalSec,
          scheduledDueEpochMs,
          actualObservationEpochMs,
          elapsedSinceDecisionMs,
          isPoolActive: false,
          spotPriceSol: null,
          baseReserveDecimal: null,
          quoteReserveDecimal: null,
          observationStatus: "RPC_UNAVAILABLE",
          censorReason: err instanceof Error ? err.message : String(err),
        };
      }

      this.appendRecord(record);
      processedCount++;
    }

    return processedCount;
  }

  /**
   * Censors all remaining pending forward observation targets that cannot complete
   * before terminal session finalization (e.g. target reached, duration expired, operator interrupt).
   * D24F-02: Guarantees zero disappearing forward outcomes at the terminal boundary.
   */
  public censorRemainingPendingTargets(
    status: "WINDOW_TRUNCATED" | "CENSORED_TERMINAL_INTERRUPT",
    reason: string,
  ): number {
    const pending = this.pendingTargets.splice(0, this.pendingTargets.length);
    const now = Date.now();
    let censoredCount = 0;

    for (const target of pending) {
      const elapsedSinceDecisionMs = now - target.candidate.decisionEpochMs;
      const record: ForwardOutcomeObservationRecord = {
        forwardObservationId: `fwd-obs-${target.candidate.compositeId.mintAddress.slice(0, 8)}-${target.targetIntervalSec}s-${now}`,
        baselineDecisionEventId: target.candidate.compositeId.decisionEventId,
        sessionId: target.candidate.compositeId.sessionId,
        generationId: target.candidate.compositeId.generationId,
        mintAddress: target.candidate.compositeId.mintAddress,
        poolId: target.candidate.compositeId.poolId,
        targetIntervalSec: target.targetIntervalSec,
        scheduledDueEpochMs: target.scheduledDueEpochMs,
        actualObservationEpochMs: now,
        elapsedSinceDecisionMs,
        isPoolActive: false,
        spotPriceSol: null,
        baseReserveDecimal: null,
        quoteReserveDecimal: null,
        observationStatus: status,
        censorReason: reason,
      };

      this.appendRecord(record);
      censoredCount++;
    }

    return censoredCount;
  }

  /**
   * Generates and writes 'forward-summary.json' into the session directory
   * before the export manifest is generated and sealed.
   */
  public writeForwardSummary(): ForwardOutcomeSummary {
    const byIntervalObj: Record<
      string,
      {
        scheduled: number;
        active: number;
        drained: number;
        closed: number;
        rpcUnavailable: number;
        truncated: number;
        censored: number;
      }
    > = {};

    for (const [sec, stats] of this.intervalStats.entries()) {
      byIntervalObj[String(sec)] = { ...stats };
    }

    const summary: ForwardOutcomeSummary = {
      totalScheduled: this.totalScheduled,
      totalRecorded: this.totalForwardObservationsRecorded,
      totalActive: this.statusCounts.OBSERVED_ACTIVE,
      totalDrained: this.statusCounts.POOL_DRAINED,
      totalClosedConfirmed: this.statusCounts.POOL_CLOSED_CONFIRMED,
      totalUnverified: this.statusCounts.UNVERIFIED_ACCOUNT,
      totalRpcUnavailable: this.statusCounts.RPC_UNAVAILABLE,
      totalTruncated: this.statusCounts.WINDOW_TRUNCATED,
      totalCensoredInterrupt: this.statusCounts.CENSORED_TERMINAL_INTERRUPT,
      remainingPending: this.pendingTargets.length,
      byInterval: byIntervalObj,
    };

    fsSync.writeFileSync(this.summaryFilePath, JSON.stringify(summary, null, 2), "utf8");
    return summary;
  }

  private appendRecord(record: ForwardOutcomeObservationRecord): void {
    const line = JSON.stringify(record) + "\n";
    fsSync.appendFileSync(this.forwardFilePath, line, "utf8");
    this.totalForwardObservationsRecorded++;
    this.statusCounts[record.observationStatus] =
      (this.statusCounts[record.observationStatus] ?? 0) + 1;

    const intervalStat = this.intervalStats.get(record.targetIntervalSec);
    if (intervalStat) {
      if (record.observationStatus === "OBSERVED_ACTIVE") intervalStat.active++;
      else if (record.observationStatus === "POOL_DRAINED") intervalStat.drained++;
      else if (record.observationStatus === "POOL_CLOSED_CONFIRMED") intervalStat.closed++;
      else if (record.observationStatus === "RPC_UNAVAILABLE") intervalStat.rpcUnavailable++;
      else if (record.observationStatus === "WINDOW_TRUNCATED") intervalStat.truncated++;
      else if (record.observationStatus === "CENSORED_TERMINAL_INTERRUPT") intervalStat.censored++;
    }
  }
}
