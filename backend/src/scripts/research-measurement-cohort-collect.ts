import { runMeasurementCohortCli } from "../research-measurement-cohort/MeasurementCohortCli.js";

try {
  process.stdout.write(await runMeasurementCohortCli(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : "Measurement collection failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
