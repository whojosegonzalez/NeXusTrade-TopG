import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import {
  FAST_SHADOW_HORIZONS,
  FAST_SHADOW_MAX_LATE_MINUTES,
} from "../shadow-fast/FastShadowTypes.js";
import type { FastEntryPrimaryLabel } from "./FastEntryAttributionTypes.js";

export function fastEntryExactCoverage(
  observations: readonly WatchlistReturnObservationRecord[],
): readonly { readonly horizonMinutes: 3 | 5 | 15; readonly onTime: boolean }[] {
  return FAST_SHADOW_HORIZONS.map((horizonMinutes) => ({
    horizonMinutes,
    onTime: exactObservation(observations, horizonMinutes) !== undefined,
  }));
}

export function fastEntryPrimaryLabel(
  observations: readonly WatchlistReturnObservationRecord[],
): FastEntryPrimaryLabel {
  const points = FAST_SHADOW_HORIZONS.flatMap((horizonMinutes) => {
    const observation = exactObservation(observations, horizonMinutes);
    const returnPct = observation ? returnValue(observation) : undefined;
    return returnPct === undefined ? [] : [{ horizonMinutes, returnPct }];
  });
  const target = points.find((point) => point.returnPct >= 10);
  const stop = points.find((point) => point.returnPct <= -15);
  if (target && stop) {
    if (target.horizonMinutes === stop.horizonMinutes) return "AMBIGUOUS";
    return target.horizonMinutes < stop.horizonMinutes ? "TARGET_FIRST" : "STOP_FIRST";
  }
  if (target) return "TARGET_FIRST";
  if (stop) return "STOP_FIRST";
  return points.some((point) => point.horizonMinutes === 15) ? "MAX_HOLD" : "NO_OBSERVATION";
}

function exactObservation(
  observations: readonly WatchlistReturnObservationRecord[],
  horizonMinutes: 3 | 5 | 15,
): WatchlistReturnObservationRecord | undefined {
  return observations
    .filter((row) => row.horizonMinutes === horizonMinutes)
    .filter((row) => row.status === "OBSERVED")
    .filter(
      (row) =>
        row.observedAtMs !== null &&
        row.observedAtMs <= row.dueAtMs + FAST_SHADOW_MAX_LATE_MINUTES * 60_000,
    )
    .filter((row) => returnValue(row) !== undefined)
    .sort(
      (left, right) =>
        (left.observedAtMs ?? Number.MAX_SAFE_INTEGER) -
        (right.observedAtMs ?? Number.MAX_SAFE_INTEGER),
    )[0];
}

function returnValue(observation: WatchlistReturnObservationRecord): number | undefined {
  const raw = observation.returnPctSol ?? observation.returnPctUsd;
  const value = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
