import {
  parseMeasurementProtocolArgs,
  type MeasurementProtocolFormat,
} from "./MeasurementProtocolConfig.js";
import {
  formatMeasurementProtocolValidationJson,
  formatMeasurementProtocolValidationMarkdown,
} from "./MeasurementProtocolFormatter.js";
import { MeasurementProtocolService } from "./MeasurementProtocolService.js";
import type { MeasurementProtocolValidationV1 } from "./MeasurementProtocolTypes.js";

export function runMeasurementProtocolCli(
  argv: readonly string[],
  write: (output: string) => void,
): MeasurementProtocolValidationV1 {
  const config = parseMeasurementProtocolArgs(argv);
  const validation = new MeasurementProtocolService({ config }).build();
  write(formatMeasurementProtocolValidation(validation, config.format));
  return validation;
}

export function formatMeasurementProtocolValidation(
  validation: MeasurementProtocolValidationV1,
  format: MeasurementProtocolFormat,
): string {
  return format === "json"
    ? formatMeasurementProtocolValidationJson(validation)
    : formatMeasurementProtocolValidationMarkdown(validation);
}
