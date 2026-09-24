import type { SessionRecord } from "../db/schema/index.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";

export type TargetSource =
  | "RUNTIME_TARGET_SOL"
  | "RUNTIME_TARGET_PCT"
  | "SESSION_TARGET_LAMPORTS"
  | "SESSION_TARGET_BPS";

export interface TargetThreshold {
  readonly source: TargetSource;
  readonly targetProfitLamports: number;
}

export interface TargetEvaluation {
  readonly threshold?: TargetThreshold;
  readonly reached: boolean;
  readonly targetEquityLamports?: number;
  readonly progressBps?: number;
}

export class TargetTrackingService {
  evaluate(
    session: SessionRecord,
    config: SessionManagerRuntimeConfig,
    totalEquityLamports: number,
  ): TargetEvaluation {
    const threshold = this.resolveThreshold(session, config);

    if (!threshold) {
      return {
        reached: false,
      };
    }

    const targetEquityLamports = session.startingBalanceLamports + threshold.targetProfitLamports;
    const profitProgressLamports = Math.max(
      0,
      totalEquityLamports - session.startingBalanceLamports,
    );

    return {
      threshold,
      reached: totalEquityLamports >= targetEquityLamports,
      targetEquityLamports,
      progressBps:
        threshold.targetProfitLamports > 0
          ? Math.round((profitProgressLamports / threshold.targetProfitLamports) * 10_000)
          : 0,
    };
  }

  private resolveThreshold(
    session: SessionRecord,
    config: SessionManagerRuntimeConfig,
  ): TargetThreshold | undefined {
    if (config.targetProfitLamports !== undefined) {
      return {
        source: "RUNTIME_TARGET_SOL",
        targetProfitLamports: config.targetProfitLamports,
      };
    }

    if (config.targetProfitPct !== undefined) {
      return {
        source: "RUNTIME_TARGET_PCT",
        targetProfitLamports: percentOfLamports(
          session.startingBalanceLamports,
          config.targetProfitPct,
        ),
      };
    }

    if (session.targetProfitLamports !== null) {
      return {
        source: "SESSION_TARGET_LAMPORTS",
        targetProfitLamports: session.targetProfitLamports,
      };
    }

    if (session.targetProfitBps !== null) {
      return {
        source: "SESSION_TARGET_BPS",
        targetProfitLamports: Math.ceil(
          (session.startingBalanceLamports * session.targetProfitBps) / 10_000,
        ),
      };
    }

    return undefined;
  }
}

export function percentOfLamports(lamports: number, percent: number): number {
  return Math.ceil((lamports * percent) / 100);
}
