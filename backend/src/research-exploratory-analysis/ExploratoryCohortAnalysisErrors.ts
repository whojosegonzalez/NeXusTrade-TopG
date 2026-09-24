export const exploratoryCohortAnalysisErrorCodes = [
  "EXPLORATORY_ANALYSIS_INVALID_SCOPE",
  "EXPLORATORY_ANALYSIS_UNSUPPORTED_ARCHIVE",
  "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
  "EXPLORATORY_ANALYSIS_ARCHIVE_NOT_FINAL",
] as const;

export type ExploratoryCohortAnalysisErrorCode =
  (typeof exploratoryCohortAnalysisErrorCodes)[number];

export class ExploratoryCohortAnalysisError extends Error {
  constructor(
    readonly code: ExploratoryCohortAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExploratoryCohortAnalysisError";
  }
}

export function formatExploratoryCohortAnalysisError(error: unknown): string {
  if (error instanceof ExploratoryCohortAnalysisError) return `${error.code}: ${error.message}`;
  return "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY: Exploratory cohort analysis failed closed.";
}
