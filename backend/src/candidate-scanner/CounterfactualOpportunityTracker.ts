import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OpportunityCohort = "EXECUTED_BUY" | "WATCHLIST_RADAR" | "FILTERED_REJECTED";

export interface CandidateObservationRecord {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly symbol: string;
  cohort: OpportunityCohort;
  rejectionReason?: string | undefined;
  readonly initialPriceSol: number;
  readonly initialLiquidityUsd: number;
  readonly initialMarketCapUsd: number;
  readonly firstSeenAtMs: number;
  lastSampledAtMs: number;
  maxPriceSol: number;
  maxGainBps: number;
  minPriceSol: number;
  minReturnBps: number;
  latestPriceSol: number;
  latestReturnBps: number;
}

export interface MissedOpportunityItem {
  readonly symbol: string;
  readonly mintAddress: string;
  readonly cohort: OpportunityCohort;
  readonly rejectionReason?: string | undefined;
  readonly initialPriceSol: number;
  readonly peakPriceSol: number;
  readonly peakGainPct: number;
  readonly durationMinutes: number;
}

export interface AvoidedRugItem {
  readonly symbol: string;
  readonly mintAddress: string;
  readonly rejectionReason?: string | undefined;
  readonly initialPriceSol: number;
  readonly lowestPriceSol: number;
  readonly maxLossPct: number;
}

export interface CounterfactualOpportunityReport {
  readonly generatedAt: string;
  readonly totalCandidatesObserved: number;
  readonly executedBuysCount: number;
  readonly watchlistRadarCount: number;
  readonly filteredRejectedCount: number;
  readonly missedWinnersCount: number;
  readonly avoidedRugsCount: number;
  readonly portfolioStartSol: number;
  readonly portfolioCurrentSol: number;
  readonly portfolioRealizedPnlSol: number;
  readonly missedWinners: readonly MissedOpportunityItem[];
  readonly avoidedRugs: readonly AvoidedRugItem[];
  readonly rejectionReasonBreakdown: Record<string, number>;
}

export class CounterfactualOpportunityTracker {
  private readonly records = new Map<string, CandidateObservationRecord>();

  public recordCandidate(
    pool: {
      readonly poolId: string;
      readonly mintAddress: string;
      readonly symbol: string;
      readonly liquidityUsd: number;
      readonly marketCapUsd: number;
      readonly spotPriceUsd?: number;
    },
    cohort: OpportunityCohort,
    initialPriceSol: number,
    nowMs: number,
    rejectionReason?: string,
  ): CandidateObservationRecord {
    const existing = this.records.get(pool.mintAddress);
    if (existing) {
      if (cohort === "EXECUTED_BUY") {
        existing.cohort = "EXECUTED_BUY";
        existing.rejectionReason = undefined;
      } else if (existing.cohort === "FILTERED_REJECTED" && cohort === "WATCHLIST_RADAR") {
        existing.cohort = "WATCHLIST_RADAR";
        existing.rejectionReason = undefined;
      }
      return existing;
    }

    const price = initialPriceSol > 0 ? initialPriceSol : (pool.spotPriceUsd ?? 0);

    const record: CandidateObservationRecord = {
      poolId: pool.poolId,
      mintAddress: pool.mintAddress,
      symbol: pool.symbol,
      cohort,
      rejectionReason,
      initialPriceSol: price,
      initialLiquidityUsd: pool.liquidityUsd,
      initialMarketCapUsd: pool.marketCapUsd,
      firstSeenAtMs: nowMs,
      lastSampledAtMs: nowMs,
      maxPriceSol: price,
      maxGainBps: 0,
      minPriceSol: price,
      minReturnBps: 0,
      latestPriceSol: price,
      latestReturnBps: 0,
    };

    this.records.set(pool.mintAddress, record);
    return record;
  }

  public recordExecutedBuy(mintAddress: string, priceSol: number, nowMs: number): void {
    const record = this.records.get(mintAddress);
    if (record) {
      record.cohort = "EXECUTED_BUY";
      record.rejectionReason = undefined;
      this.samplePrice(mintAddress, priceSol, nowMs);
    }
  }

  public samplePrice(mintAddress: string, currentPriceSol: number, nowMs: number): void {
    const record = this.records.get(mintAddress);
    if (!record || currentPriceSol <= 0) return;

    record.lastSampledAtMs = nowMs;
    record.latestPriceSol = currentPriceSol;

    const returnBps = Math.round(
      ((currentPriceSol - record.initialPriceSol) / record.initialPriceSol) * 10_000,
    );
    record.latestReturnBps = returnBps;

    if (currentPriceSol > record.maxPriceSol) {
      record.maxPriceSol = currentPriceSol;
      record.maxGainBps = returnBps;
    }

    if (currentPriceSol < record.minPriceSol) {
      record.minPriceSol = currentPriceSol;
      record.minReturnBps = returnBps;
    }
  }

  public getRecords(): readonly CandidateObservationRecord[] {
    return Array.from(this.records.values());
  }

  public generateReport(
    portfolioStartSol: number,
    portfolioCurrentSol: number,
  ): CounterfactualOpportunityReport {
    const allRecords = Array.from(this.records.values());

    const executedBuys = allRecords.filter((r) => r.cohort === "EXECUTED_BUY");
    const watchlistRadar = allRecords.filter((r) => r.cohort === "WATCHLIST_RADAR");
    const filteredRejected = allRecords.filter((r) => r.cohort === "FILTERED_REJECTED");

    // Missed winners: Not bought, but peaked at >= +15.0% (+1500 bps)
    const missedWinners: MissedOpportunityItem[] = allRecords
      .filter((r) => r.cohort !== "EXECUTED_BUY" && r.maxGainBps >= 1500)
      .sort((a, b) => b.maxGainBps - a.maxGainBps)
      .map((r) => ({
        symbol: r.symbol,
        mintAddress: r.mintAddress,
        cohort: r.cohort,
        rejectionReason: r.rejectionReason,
        initialPriceSol: r.initialPriceSol,
        peakPriceSol: r.maxPriceSol,
        peakGainPct: r.maxGainBps / 100,
        durationMinutes: Math.max(1, Math.round((r.lastSampledAtMs - r.firstSeenAtMs) / 60000)),
      }));

    // Avoided rugs: Rejected tokens that dropped <= -30.0% (-3000 bps)
    const avoidedRugs: AvoidedRugItem[] = filteredRejected
      .filter((r) => r.minReturnBps <= -3000)
      .sort((a, b) => a.minReturnBps - b.minReturnBps)
      .map((r) => ({
        symbol: r.symbol,
        mintAddress: r.mintAddress,
        rejectionReason: r.rejectionReason,
        initialPriceSol: r.initialPriceSol,
        lowestPriceSol: r.minPriceSol,
        maxLossPct: r.minReturnBps / 100,
      }));

    // Breakdown of rejection reasons
    const rejectionReasonBreakdown: Record<string, number> = {};
    for (const r of filteredRejected) {
      const reason = r.rejectionReason ?? "UNKNOWN";
      rejectionReasonBreakdown[reason] = (rejectionReasonBreakdown[reason] ?? 0) + 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      totalCandidatesObserved: allRecords.length,
      executedBuysCount: executedBuys.length,
      watchlistRadarCount: watchlistRadar.length,
      filteredRejectedCount: filteredRejected.length,
      missedWinnersCount: missedWinners.length,
      avoidedRugsCount: avoidedRugs.length,
      portfolioStartSol,
      portfolioCurrentSol,
      portfolioRealizedPnlSol: portfolioCurrentSol - portfolioStartSol,
      missedWinners,
      avoidedRugs,
      rejectionReasonBreakdown,
    };
  }

  public saveReportToFile(
    filePath: string,
    portfolioStartSol: number,
    portfolioCurrentSol: number,
  ): void {
    const report = this.generateReport(portfolioStartSol, portfolioCurrentSol);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  }
}
