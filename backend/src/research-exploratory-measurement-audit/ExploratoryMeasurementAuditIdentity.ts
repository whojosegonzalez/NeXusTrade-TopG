import {
  measurementAuditArtifactNames,
  type MeasurementAuditArtifactName,
} from "./ExploratoryMeasurementAuditTypes.js";

export const EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT =
  "data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z" as const;
export const EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json" as const;
export const EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256 =
  "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed" as const;

export interface ExploratoryMeasurementAuditIdentity {
  readonly protocolSha256: string;
  readonly artifacts: Readonly<Record<MeasurementAuditArtifactName, string>>;
}

export const EXPLORATORY_MEASUREMENT_AUDIT_APPROVED_IDENTITY = {
  protocolSha256: EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256,
  artifacts: {
    "cohort-manifest.v1.json": "0d462555a476cbec4c983d259f6ea3c96a3ef65486a9de7484b65fb2b690f48b",
    "units.v1.ndjson": "feb8515e0adf50ac86660bbfd378133b45303ed9a4ef57e0d0d73536f0542a9c",
    "source-inventory.v1.json": "766b8315366b13372fa33218b3b483e359055d88a9f7d5f53ff8de560866212a",
    "collection-summary.v1.json":
      "a6bab14209e5c0d0a16a76617866144e1349d862d7446751d699c8b890fb2940",
  },
} as const satisfies ExploratoryMeasurementAuditIdentity;

export { measurementAuditArtifactNames };
