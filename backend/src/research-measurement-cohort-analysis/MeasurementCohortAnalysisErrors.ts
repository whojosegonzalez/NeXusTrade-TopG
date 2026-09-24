export const measurementCohortAnalysisErrorCodes = [
  "MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE",
  "MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED",
  "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
  "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
  "MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION",
] as const;

export type MeasurementCohortAnalysisErrorCode =
  (typeof measurementCohortAnalysisErrorCodes)[number];

export class MeasurementCohortAnalysisError extends Error {
  constructor(
    readonly code: MeasurementCohortAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeasurementCohortAnalysisError";
  }
}

export function formatMeasurementCohortAnalysisError(error: unknown): string {
  if (error instanceof MeasurementCohortAnalysisError) return `${error.code}: ${error.message}`;
  return "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY: Measurement cohort analysis failed closed.";
}
