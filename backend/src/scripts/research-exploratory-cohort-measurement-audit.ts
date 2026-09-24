import { runExploratoryMeasurementAuditCli } from "../research-exploratory-measurement-audit/ExploratoryMeasurementAuditCli.js";
import { formatExploratoryMeasurementAuditError } from "../research-exploratory-measurement-audit/ExploratoryMeasurementAuditErrors.js";

try {
  runExploratoryMeasurementAuditCli(process.argv.slice(2), (output) =>
    process.stdout.write(output),
  );
} catch (error: unknown) {
  process.stderr.write(`${formatExploratoryMeasurementAuditError(error)}\n`);
  process.exitCode = 1;
}
