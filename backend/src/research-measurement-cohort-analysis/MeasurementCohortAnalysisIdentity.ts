import {
  measurementCohortAnalysisArtifactNames,
  type MeasurementCohortAnalysisArtifactName,
} from "./MeasurementCohortAnalysisTypes.js";

export const MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT =
  "data/archive/phase10.6a/measurement-v3-20260904-2100Z" as const;
export const MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json" as const;
export const MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256 =
  "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458" as const;

export interface MeasurementCohortAnalysisIdentity {
  readonly protocolSha256: typeof MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256;
  readonly artifacts: Readonly<Record<MeasurementCohortAnalysisArtifactName, string>>;
}

/**
 * Source-controlled identity of the one separately reviewed final V3 archive.
 * The production CLI accepts no identity, root, protocol, or output override.
 */
export const MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY = {
  protocolSha256: MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
  artifacts: {
    "cohort-manifest.v1.json": "15cdf48a48d21f9533a2db1dea36aeac41ca180127ff174fa90ad21c433efd8b",
    "units.v1.ndjson": "10d86dd3e4d03eb5c57b40ac358b8cc683de5dcfaac97659688736710289fe29",
    "source-inventory.v1.json": "45239e8ee422b6c240592093d85347b8fa7ba4cf512a0ee735951f585c5ac7bc",
    "collection-summary.v1.json":
      "22d29fb0528ad568f070a229c65a429bfc797563fe53b3d64d7198f556f74f68",
  },
} as const satisfies MeasurementCohortAnalysisIdentity;

export { measurementCohortAnalysisArtifactNames };
