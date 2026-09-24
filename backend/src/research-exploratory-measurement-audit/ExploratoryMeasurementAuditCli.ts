import {
  parseExploratoryMeasurementAuditArgs,
  resolveExploratoryMeasurementAuditArchive,
} from "./ExploratoryMeasurementAuditConfig.js";
import {
  formatExploratoryMeasurementAuditJson,
  formatExploratoryMeasurementAuditMarkdown,
} from "./ExploratoryMeasurementAuditFormatter.js";
import { getExploratoryMeasurementAuditRepoRoot } from "./ExploratoryMeasurementAuditPaths.js";
import { ExploratoryMeasurementAuditService } from "./ExploratoryMeasurementAuditService.js";
import type { DecisionTimeMeasurementAuditV1 } from "./ExploratoryMeasurementAuditTypes.js";

export function runExploratoryMeasurementAuditCli(
  argv: readonly string[],
  write: (output: string) => void,
): DecisionTimeMeasurementAuditV1 {
  const config = parseExploratoryMeasurementAuditArgs(argv);
  const repoRoot = getExploratoryMeasurementAuditRepoRoot();
  const archiveRoot = resolveExploratoryMeasurementAuditArchive(config, repoRoot);
  const audit = new ExploratoryMeasurementAuditService().build(archiveRoot, repoRoot);
  write(
    config.format === "json"
      ? formatExploratoryMeasurementAuditJson(audit)
      : formatExploratoryMeasurementAuditMarkdown(audit),
  );
  return audit;
}
