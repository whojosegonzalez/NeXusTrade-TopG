import { runExploratoryCohortAnalysisCli } from "../research-exploratory-analysis/ExploratoryCohortAnalysisCli.js";
import { formatExploratoryCohortAnalysisError } from "../research-exploratory-analysis/ExploratoryCohortAnalysisErrors.js";

try {
  runExploratoryCohortAnalysisCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatExploratoryCohortAnalysisError(error)}\n`);
  process.exitCode = 1;
}
