import path from "node:path";

import { MeasurementCohortAnalysisError } from "./MeasurementCohortAnalysisErrors.js";
import { MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT } from "./MeasurementCohortAnalysisIdentity.js";
import {
  getMeasurementCohortAnalysisRepoRoot,
  isSafeMeasurementCohortAnalysisPath,
} from "./MeasurementCohortAnalysisPaths.js";
import {
  measurementCohortAnalysisFormatSchema,
  type MeasurementCohortAnalysisFormat,
} from "./MeasurementCohortAnalysisTypes.js";

const forbiddenPrefixes = [
  "--archive",
  "--root",
  "--protocol",
  "--identity",
  "--output",
  "--write",
  "--save",
  "--file",
  "--db",
  "--database",
  "--runtime",
  "--scanner",
  "--watchlist",
  "--risk",
  "--strategy",
  "--provider",
  "--environment",
  "--env",
  "--session",
  "--score",
  "--threshold",
  "--target",
  "--stop",
  "--monitor",
  "--scheduler",
  "--wallet",
  "--sign",
  "--submit",
  "--paper",
  "--live",
  "--execution",
  "--order",
  "--fill",
  "--position",
  "--balance",
  "--url",
  "--http",
  "--phase",
  "--cohort",
  "--include",
] as const;

export interface MeasurementCohortAnalysisConfig {
  readonly format: MeasurementCohortAnalysisFormat;
  readonly once: boolean;
}

export function parseMeasurementCohortAnalysisArgs(
  argv: readonly string[],
): MeasurementCohortAnalysisConfig {
  let format: MeasurementCohortAnalysisFormat = "markdown";
  let formatSeen = false;
  let once = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw invalidScope(
        "Measurement cohort analysis rejects archive overrides and unsafe runtime or execution options.",
      );
    }
    if (arg === "--once") {
      if (once) throw invalidScope("Measurement cohort analysis accepts --once at most once.");
      once = true;
      continue;
    }
    if (arg.startsWith("--format=")) {
      if (formatSeen)
        throw invalidScope("Measurement cohort analysis accepts --format at most once.");
      const parsed = measurementCohortAnalysisFormatSchema.safeParse(arg.slice("--format=".length));
      if (!parsed.success) {
        throw invalidScope("Measurement cohort analysis format must be markdown or json.");
      }
      format = parsed.data;
      formatSeen = true;
      continue;
    }
    if (arg === "--format") {
      throw invalidScope(
        "Measurement cohort analysis requires --format=markdown or --format=json.",
      );
    }
    throw invalidScope("Measurement cohort analysis received an unsupported option.");
  }
  return { format, once };
}

export function resolveMeasurementCohortAnalysisArchive(
  repoRoot = getMeasurementCohortAnalysisRepoRoot(),
): string {
  const resolved = path.resolve(repoRoot, MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT);
  if (!isSafeMeasurementCohortAnalysisPath(repoRoot, resolved, "directory")) {
    throw new MeasurementCohortAnalysisError(
      "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
      "The approved V3 archive root is unavailable or unsafe.",
    );
  }
  return resolved;
}

function invalidScope(message: string): MeasurementCohortAnalysisError {
  return new MeasurementCohortAnalysisError("MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE", message);
}
