export const MEASUREMENT_PROTOCOL_V3_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json" as const;

export const MEASUREMENT_PROTOCOL_V3_SHA256 =
  "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458" as const;

export const PHASE10_6B_1_MEASUREMENT_AUDIT_FINGERPRINT =
  "843d1d27aee452f7fcccb000128fec10a38d0fbe80652fc9eb50511a9447b486" as const;

export const EXPLORATORY_COHORT_V2_ARCHIVE_ROOT =
  "data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z" as const;

export const EXPLORATORY_COHORT_V2_PROTOCOL_SHA256 =
  "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed" as const;

export const measurementProtocolErrorCodes = [
  "MEASUREMENT_PROTOCOL_INVALID_SCOPE",
  "MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT",
  "MEASUREMENT_PROTOCOL_SOURCE_INCONSISTENCY",
] as const;

export type MeasurementProtocolErrorCode = (typeof measurementProtocolErrorCodes)[number];
