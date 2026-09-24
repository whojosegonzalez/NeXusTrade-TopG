export const exploratoryMeasurementAuditErrorCodes = [
  "EXPLORATORY_MEASUREMENT_AUDIT_INVALID_SCOPE",
  "EXPLORATORY_MEASUREMENT_AUDIT_UNSUPPORTED_ARCHIVE",
  "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
  "EXPLORATORY_MEASUREMENT_AUDIT_LABEL_QUARANTINE_VIOLATION",
] as const;

export type ExploratoryMeasurementAuditErrorCode =
  (typeof exploratoryMeasurementAuditErrorCodes)[number];

export class ExploratoryMeasurementAuditError extends Error {
  constructor(
    readonly code: ExploratoryMeasurementAuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExploratoryMeasurementAuditError";
  }
}

export function formatExploratoryMeasurementAuditError(error: unknown): string {
  if (error instanceof ExploratoryMeasurementAuditError) return `${error.code}: ${error.message}`;
  return "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY: Measurement audit failed closed.";
}
