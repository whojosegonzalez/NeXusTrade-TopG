import type { MeasurementProtocolErrorCode } from "./MeasurementProtocolConstants.js";

export class MeasurementProtocolError extends Error {
  constructor(
    readonly code: MeasurementProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeasurementProtocolError";
  }
}

export function formatMeasurementProtocolError(error: unknown): string {
  if (error instanceof MeasurementProtocolError) return `${error.code}: ${error.message}`;
  return "MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT: Measurement protocol validation failed closed.";
}
