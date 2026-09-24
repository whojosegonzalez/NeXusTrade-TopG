export const MEASUREMENT_COHORT_PROTOCOL_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json" as const;

export const MEASUREMENT_COHORT_PROTOCOL_SHA256 =
  "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458" as const;

export const MEASUREMENT_COHORT_STATIC_FINGERPRINT =
  "b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6" as const;

export const MEASUREMENT_COHORT_ARCHIVE_PREFIX = "data/archive/phase10.6a/measurement-v3-" as const;

export const MEASUREMENT_COHORT_LAUNCH_PREFIX =
  "docs/research-launches/phase10.6a-measurement-v3-" as const;

export const MEASUREMENT_COHORT_TIMING = {
  slotDurationMs: 120 * 60 * 1000,
  invocationLeadMs: 16 * 60 * 1000,
  snapshotOffsetsMinutes: [-15, -10, -5, 0] as const,
  sourceFreshnessMs: 60 * 1000,
  maximumAttemptedSlots: 168,
  plannedUnits: 96,
  minimumValidUnits: 72,
  minimumPartitionUnits: 32,
  minimumPartitionDates: 4,
  minimumDates: 8,
  maximumDateSharePct: 20,
  minimumDistinctMints: 72,
  minimumAvailabilityPct: 90,
  discoveryCap: 168,
  marketContextCap: 672,
} as const;

export const MEASUREMENT_COHORT_ARCHIVE_FILES = {
  manifest: "cohort-manifest.v1.json",
  units: "units.v1.ndjson",
  sourceInventory: "source-inventory.v1.json",
  summary: "collection-summary.v1.json",
  lock: "collection.lock",
} as const;

/** A locked process must have finished at the source-derived anchor plus freshness allowance. */
export const MEASUREMENT_COHORT_STALE_LOCK_GRACE_MS = MEASUREMENT_COHORT_TIMING.sourceFreshnessMs;
