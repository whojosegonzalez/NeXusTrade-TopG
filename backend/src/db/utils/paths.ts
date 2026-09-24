import path from "node:path";
import { fileURLToPath } from "node:url";

const dbUtilsDir = path.dirname(fileURLToPath(import.meta.url));

export function getRepoRoot(): string {
  return path.resolve(dbUtilsDir, "..", "..", "..", "..");
}
