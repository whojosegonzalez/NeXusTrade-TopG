export const exploratoryCohortAnalysisArtifactNames = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
] as const;

export type ExploratoryCohortAnalysisArtifactName =
  (typeof exploratoryCohortAnalysisArtifactNames)[number];

export type ExploratoryCohortAnalysisArchiveIdentity = Readonly<
  Record<ExploratoryCohortAnalysisArtifactName, string>
>;

/**
 * The only production Phase 10.6B input identity. These immutable final-file
 * hashes are intentionally fixed in source; the CLI does not accept overrides.
 */
export const EXPLORATORY_COHORT_ANALYSIS_APPROVED_ARCHIVE_IDENTITY = {
  "cohort-manifest.v1.json": "0d462555a476cbec4c983d259f6ea3c96a3ef65486a9de7484b65fb2b690f48b",
  "units.v1.ndjson": "feb8515e0adf50ac86660bbfd378133b45303ed9a4ef57e0d0d73536f0542a9c",
  "source-inventory.v1.json": "766b8315366b13372fa33218b3b483e359055d88a9f7d5f53ff8de560866212a",
  "collection-summary.v1.json": "a6bab14209e5c0d0a16a76617866144e1349d862d7446751d699c8b890fb2940",
} as const satisfies ExploratoryCohortAnalysisArchiveIdentity;
