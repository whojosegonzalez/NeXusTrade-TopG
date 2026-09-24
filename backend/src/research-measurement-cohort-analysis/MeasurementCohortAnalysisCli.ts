import {
  MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY,
  type MeasurementCohortAnalysisIdentity,
} from "./MeasurementCohortAnalysisIdentity.js";
import {
  parseMeasurementCohortAnalysisArgs,
  resolveMeasurementCohortAnalysisArchive,
} from "./MeasurementCohortAnalysisConfig.js";
import { MeasurementCohortAnalysisError } from "./MeasurementCohortAnalysisErrors.js";
import {
  formatMeasurementCohortAnalysisJson,
  formatMeasurementCohortAnalysisMarkdown,
} from "./MeasurementCohortAnalysisFormatter.js";
import { MeasurementCohortAnalysisLoader } from "./MeasurementCohortAnalysisLoader.js";
import { getMeasurementCohortAnalysisRepoRoot } from "./MeasurementCohortAnalysisPaths.js";
import { MeasurementCohortAnalysisService } from "./MeasurementCohortAnalysisService.js";
import type { MeasurementCohortAnalysisV1 } from "./MeasurementCohortAnalysisTypes.js";

interface MeasurementCohortAnalysisCliTestDependencies {
  /** Test-only injection; no CLI argument can alter the production identity. */
  readonly approvedIdentity?: MeasurementCohortAnalysisIdentity | undefined;
}

export function runMeasurementCohortAnalysisCli(
  argv: readonly string[],
  write: (output: string) => void,
  testDependencies: MeasurementCohortAnalysisCliTestDependencies = {},
): MeasurementCohortAnalysisV1 {
  const config = parseMeasurementCohortAnalysisArgs(argv);
  const approvedIdentity = Object.hasOwn(testDependencies, "approvedIdentity")
    ? testDependencies.approvedIdentity
    : MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY;
  if (!approvedIdentity) {
    throw new MeasurementCohortAnalysisError(
      "MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED",
      "The V3 final archive identity is unavailable.",
    );
  }
  const repoRoot = getMeasurementCohortAnalysisRepoRoot();
  const archiveRoot = resolveMeasurementCohortAnalysisArchive(repoRoot);
  const analysis = new MeasurementCohortAnalysisService({
    loader: new MeasurementCohortAnalysisLoader({
      identity: approvedIdentity,
    }),
  }).build(archiveRoot, repoRoot);
  write(
    config.format === "json"
      ? formatMeasurementCohortAnalysisJson(analysis)
      : formatMeasurementCohortAnalysisMarkdown(analysis),
  );
  return analysis;
}
