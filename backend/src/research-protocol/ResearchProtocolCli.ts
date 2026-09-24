import {
  parseResearchProtocolArgs,
  type ResearchProtocolFormat,
} from "./ResearchProtocolConfig.js";
import {
  formatResearchProtocolValidationJson,
  formatResearchProtocolValidationMarkdown,
} from "./ResearchProtocolFormatter.js";
import { ResearchProtocolService } from "./ResearchProtocolService.js";
import type { ResearchProtocolValidationV1 } from "./ResearchProtocolTypes.js";

export function runResearchProtocolCli(
  argv: readonly string[],
  write: (output: string) => void,
): ResearchProtocolValidationV1 {
  const config = parseResearchProtocolArgs(argv);
  const validation = new ResearchProtocolService({ config }).build();
  write(formatResearchProtocolValidation(validation, config.format));
  return validation;
}

export function formatResearchProtocolValidation(
  validation: ResearchProtocolValidationV1,
  format: ResearchProtocolFormat,
): string {
  return format === "json"
    ? formatResearchProtocolValidationJson(validation)
    : formatResearchProtocolValidationMarkdown(validation);
}
