import {
  EXPLORATORY_COHORT_DISCOVERY_LEAD_MS,
  EXPLORATORY_COHORT_MAX_SLOTS,
  EXPLORATORY_COHORT_SLOT_MS,
} from "./ExploratoryCohortConstants.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";

export interface ExploratoryCohortScheduleSlot {
  readonly slotIndex: number;
  readonly slotId: string;
  readonly anchorAt: Date;
  readonly invocationStartsAt: Date;
}

export function canonicalExploratoryCohortSlot(
  cohortStartAt: string,
  slotIndex: number,
): ExploratoryCohortScheduleSlot {
  const start = new Date(cohortStartAt);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= EXPLORATORY_COHORT_MAX_SLOTS
  ) {
    throw precondition("The registered cohort schedule is invalid.");
  }
  const anchorAt = new Date(start.getTime() + (slotIndex + 1) * EXPLORATORY_COHORT_SLOT_MS);
  return {
    slotIndex,
    slotId: `SLOT_${String(slotIndex + 1).padStart(3, "0")}`,
    anchorAt,
    invocationStartsAt: new Date(anchorAt.getTime() - EXPLORATORY_COHORT_DISCOVERY_LEAD_MS),
  };
}

export function deriveCurrentExploratoryCohortSlot(
  cohortStartAt: string,
  now: Date,
): ExploratoryCohortScheduleSlot {
  const start = new Date(cohortStartAt);
  if (!Number.isFinite(start.getTime()) || now.getTime() < start.getTime()) {
    throw precondition("The collection clock is outside the registered cohort window.");
  }
  const slotIndex = Math.floor((now.getTime() - start.getTime()) / EXPLORATORY_COHORT_SLOT_MS);
  return canonicalExploratoryCohortSlot(cohortStartAt, slotIndex);
}

export function assertExploratoryCohortStartWindow(
  schedule: ExploratoryCohortScheduleSlot,
  now: Date,
): void {
  if (
    now.getTime() < schedule.invocationStartsAt.getTime() ||
    now.getTime() > schedule.anchorAt.getTime()
  ) {
    throw precondition(
      "The external invocation must start from slot end minus 60 seconds through slot end.",
    );
  }
}

export function exploratoryCohortFinalizerEarliestAt(cohortStartAt: string): Date {
  const start = new Date(cohortStartAt);
  if (!Number.isFinite(start.getTime()))
    throw precondition("The registered cohort start is invalid.");
  return new Date(start.getTime() + (337 * 60 * 60 + 60) * 1_000);
}

function precondition(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_PRECONDITION_UNMET", message);
}
