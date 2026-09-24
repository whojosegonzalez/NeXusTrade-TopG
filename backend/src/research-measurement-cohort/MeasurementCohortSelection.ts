import { createHash } from "node:crypto";

import type {
  MeasurementCohortPartition,
  MeasurementDiscoveryCandidate,
} from "./MeasurementCohortTypes.js";

export const measurementSeed = "phase10.6a-exploratory-cohort.v3" as const;
const base58Mint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function canonicalCandidates(
  candidates: readonly MeasurementDiscoveryCandidate[],
): readonly MeasurementDiscoveryCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        base58Mint.test(candidate.mint) &&
        candidate.sourceKind.length > 0 &&
        !Number.isNaN(candidate.firstObservedAt.valueOf()),
    )
    .sort((left, right) => left.mint.localeCompare(right.mint));
}

export function selectionHash(mint: string, slotId: string): string {
  return createHash("sha256").update(`${measurementSeed}|${mint}|${slotId}`).digest("hex");
}

export function selectCandidate(
  candidates: readonly MeasurementDiscoveryCandidate[],
  slotId: string,
): MeasurementDiscoveryCandidate | undefined {
  return candidates
    .map((candidate) => ({ candidate, hash: selectionHash(candidate.mint, slotId) }))
    .sort(
      (left, right) =>
        left.hash.localeCompare(right.hash) ||
        left.candidate.mint.localeCompare(right.candidate.mint),
    )[0]?.candidate;
}

export function partitionFor(mint: string, slotId: string): MeasurementCohortPartition {
  const last = selectionHash(mint, slotId).at(-1);
  if (!last) throw new Error("Selection hash is unexpectedly empty.");
  return Number.parseInt(last, 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
}
