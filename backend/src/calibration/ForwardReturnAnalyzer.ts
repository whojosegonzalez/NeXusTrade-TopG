import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import type { ForwardReturnMetrics, ReturnPoint, ThresholdEvent } from "./CalibrationTypes.js";

export interface ForwardReturnAnalyzerConfig {
  readonly horizonsMinutes: readonly number[];
  readonly maxHoldMinutes: number;
  readonly targetPcts: readonly number[];
  readonly drawdownPcts: readonly number[];
}

export class ForwardReturnAnalyzer {
  constructor(private readonly config: ForwardReturnAnalyzerConfig) {}

  analyze(observations: readonly WatchlistReturnObservationRecord[]): ForwardReturnMetrics {
    const observedPoints = observations
      .filter((observation) => observation.status === "OBSERVED")
      .filter((observation) => this.config.horizonsMinutes.includes(observation.horizonMinutes))
      .filter((observation) => observation.horizonMinutes <= this.config.maxHoldMinutes)
      .map(toReturnPoint)
      .filter((point): point is ReturnPoint => point !== undefined)
      .sort((left, right) => left.horizonMinutes - right.horizonMinutes);
    const best = observedPoints.slice().sort((left, right) => right.returnPct - left.returnPct)[0];
    const worst = observedPoints.slice().sort((left, right) => left.returnPct - right.returnPct)[0];
    const targetHits = this.config.targetPcts.flatMap((targetPct) =>
      firstEvent(observedPoints, targetPct, (returnPct) => returnPct >= targetPct),
    );
    const drawdownBreaches = this.config.drawdownPcts.flatMap((drawdownPct) =>
      firstEvent(observedPoints, drawdownPct, (returnPct) => returnPct <= -drawdownPct),
    );

    return {
      observedPoints,
      ...(best ? { bestReturnPct: best.returnPct, bestHorizonMinutes: best.horizonMinutes } : {}),
      ...(worst
        ? { worstReturnPct: worst.returnPct, worstHorizonMinutes: worst.horizonMinutes }
        : {}),
      targetHits,
      drawdownBreaches,
      ambiguousTargetStopOrdering: hasAmbiguousTargetStopOrdering(targetHits, drawdownBreaches),
    };
  }
}

function toReturnPoint(observation: WatchlistReturnObservationRecord): ReturnPoint | undefined {
  const returnPct = Number(observation.returnPctSol ?? observation.returnPctUsd);

  if (!Number.isFinite(returnPct)) {
    return undefined;
  }

  return {
    horizonMinutes: observation.horizonMinutes,
    returnPct,
  };
}

function firstEvent(
  observedPoints: readonly ReturnPoint[],
  thresholdPct: number,
  predicate: (returnPct: number) => boolean,
): readonly ThresholdEvent[] {
  const point = observedPoints.find((candidate) => predicate(candidate.returnPct));

  if (!point) {
    return [];
  }

  return [
    {
      thresholdPct,
      horizonMinutes: point.horizonMinutes,
      returnPct: point.returnPct,
    },
  ];
}

function hasAmbiguousTargetStopOrdering(
  targetHits: readonly ThresholdEvent[],
  drawdownBreaches: readonly ThresholdEvent[],
): boolean {
  return targetHits.some((target) =>
    drawdownBreaches.some((drawdown) => drawdown.horizonMinutes === target.horizonMinutes),
  );
}
