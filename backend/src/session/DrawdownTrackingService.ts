import type { EquitySnapshotRecord, SessionRecord } from "../db/schema/index.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";
import { percentOfLamports } from "./TargetTrackingService.js";

export type DrawdownSource =
  | "RUNTIME_DRAWDOWN_SOL"
  | "RUNTIME_DRAWDOWN_PCT"
  | "SESSION_DRAWDOWN_LAMPORTS";

export interface DrawdownThreshold {
  readonly source: DrawdownSource;
  readonly maxDrawdownLamports: number;
}

export interface DrawdownEvaluation {
  readonly threshold?: DrawdownThreshold;
  readonly reached: boolean;
  readonly peakEquityLamports: number;
  readonly drawdownLamports: number;
  readonly progressBps?: number;
}

export class DrawdownTrackingService {
  evaluate(input: {
    readonly session: SessionRecord;
    readonly config: SessionManagerRuntimeConfig;
    readonly totalEquityLamports: number;
    readonly peakEquitySnapshot?: EquitySnapshotRecord;
  }): DrawdownEvaluation {
    const peakEquityLamports = Math.max(
      input.session.startingBalanceLamports,
      input.peakEquitySnapshot?.totalEquityLamports ?? 0,
      input.totalEquityLamports,
    );
    const drawdownLamports = Math.max(0, peakEquityLamports - input.totalEquityLamports);
    const threshold = this.resolveThreshold(input.session, input.config);

    if (!threshold) {
      return {
        reached: false,
        peakEquityLamports,
        drawdownLamports,
      };
    }

    return {
      threshold,
      reached: drawdownLamports >= threshold.maxDrawdownLamports,
      peakEquityLamports,
      drawdownLamports,
      progressBps:
        threshold.maxDrawdownLamports > 0
          ? Math.round((drawdownLamports / threshold.maxDrawdownLamports) * 10_000)
          : 0,
    };
  }

  private resolveThreshold(
    session: SessionRecord,
    config: SessionManagerRuntimeConfig,
  ): DrawdownThreshold | undefined {
    if (config.maxDrawdownLamports !== undefined) {
      return {
        source: "RUNTIME_DRAWDOWN_SOL",
        maxDrawdownLamports: config.maxDrawdownLamports,
      };
    }

    if (config.maxDrawdownPct !== undefined) {
      return {
        source: "RUNTIME_DRAWDOWN_PCT",
        maxDrawdownLamports: percentOfLamports(
          session.startingBalanceLamports,
          config.maxDrawdownPct,
        ),
      };
    }

    if (session.maxDrawdownLamports !== null) {
      return {
        source: "SESSION_DRAWDOWN_LAMPORTS",
        maxDrawdownLamports: session.maxDrawdownLamports,
      };
    }

    return undefined;
  }
}
