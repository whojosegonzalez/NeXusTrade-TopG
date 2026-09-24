import { formatMeasurementProtocolError } from "../research-measurement-protocol/MeasurementProtocolErrors.js";
import { runMeasurementProtocolCli } from "../research-measurement-protocol/MeasurementProtocolCli.js";

try {
  runMeasurementProtocolCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatMeasurementProtocolError(error)}\n`);
  process.exitCode = 1;
}
