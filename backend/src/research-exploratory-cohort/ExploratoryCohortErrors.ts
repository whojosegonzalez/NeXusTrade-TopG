export const exploratoryCohortErrorCodes = [
  "EXPLORATORY_COHORT_INVALID_SCOPE",
  "EXPLORATORY_COHORT_PROTOCOL_INCONSISTENCY",
  "EXPLORATORY_COHORT_ARCHIVE_CONFLICT",
  "EXPLORATORY_COHORT_PRECONDITION_UNMET",
  "EXPLORATORY_COHORT_DATA_QUALITY_STOP",
  "EXPLORATORY_COHORT_PROVIDER_BUDGET_EXHAUSTED",
] as const;

export type ExploratoryCohortErrorCode = (typeof exploratoryCohortErrorCodes)[number];

export class ExploratoryCohortError extends Error {
  constructor(
    readonly code: ExploratoryCohortErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExploratoryCohortError";
  }
}

export function formatExploratoryCohortError(error: unknown): string {
  if (error instanceof ExploratoryCohortError) return `${error.code}: ${error.message}`;
  return "EXPLORATORY_COHORT_DATA_QUALITY_STOP: Exploratory cohort collection failed closed.";
}
