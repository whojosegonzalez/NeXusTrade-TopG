import { runMeasurementCohortAnalysisCli } from "../research-measurement-cohort-analysis/MeasurementCohortAnalysisCli.js";
import { formatMeasurementCohortAnalysisError } from "../research-measurement-cohort-analysis/MeasurementCohortAnalysisErrors.js";

try {
  runMeasurementCohortAnalysisCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatMeasurementCohortAnalysisError(error)}\n`);
  process.exitCode = 1;
}
