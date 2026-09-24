import path from "node:path";
import { fileURLToPath } from "node:url";

const auditDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getExploratoryMeasurementAuditRepoRoot(): string {
  return path.resolve(auditDirectory, "..", "..", "..");
}
