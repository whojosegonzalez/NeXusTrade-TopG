import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parseMeasurementProtocolDraft } from "../research-measurement-protocol/MeasurementProtocolService.js";
import {
  MEASUREMENT_COHORT_PROTOCOL_PATH,
  MEASUREMENT_COHORT_PROTOCOL_SHA256,
  MEASUREMENT_COHORT_STATIC_FINGERPRINT,
} from "./MeasurementCohortConstants.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";

export interface PinnedMeasurementProtocol {
  readonly path: typeof MEASUREMENT_COHORT_PROTOCOL_PATH;
  readonly sha256: typeof MEASUREMENT_COHORT_PROTOCOL_SHA256;
  readonly staticValidationFingerprint: typeof MEASUREMENT_COHORT_STATIC_FINGERPRINT;
}

export function loadPinnedMeasurementProtocol(protocolPath: string): PinnedMeasurementProtocol {
  const bytes = readFileSync(protocolPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== MEASUREMENT_COHORT_PROTOCOL_SHA256) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_PROTOCOL_INCONSISTENCY",
      "The V3 protocol bytes do not match the approved SHA-256 identity.",
    );
  }
  try {
    parseMeasurementProtocolDraft(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof MeasurementCohortError) throw error;
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_PROTOCOL_INCONSISTENCY",
      "The approved V3 protocol does not meet its strict static schema.",
    );
  }
  return {
    path: MEASUREMENT_COHORT_PROTOCOL_PATH,
    sha256: MEASUREMENT_COHORT_PROTOCOL_SHA256,
    staticValidationFingerprint: MEASUREMENT_COHORT_STATIC_FINGERPRINT,
  };
}
