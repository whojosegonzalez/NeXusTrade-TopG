export const measurementCohortErrorCodes = [
  "MEASUREMENT_COHORT_INVALID_SCOPE",
  "MEASUREMENT_COHORT_PROTOCOL_INCONSISTENCY",
  "MEASUREMENT_COHORT_LAUNCH_INCONSISTENCY",
  "MEASUREMENT_COHORT_ARCHIVE_CONFLICT",
  "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
  "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
  "PROTOCOL_FIDELITY_REVIEW_REQUIRED",
] as const;

export type MeasurementCohortErrorCode = (typeof measurementCohortErrorCodes)[number];

export class MeasurementCohortError extends Error {
  constructor(
    readonly code: MeasurementCohortErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeasurementCohortError";
  }
}
